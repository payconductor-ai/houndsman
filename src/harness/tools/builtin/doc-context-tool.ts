/**
 * Tool `doc_context` — trechos de docs mapeados (nunca o documento inteiro).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";
import { TOOL_LIMITS } from "../result-limiter";
import { readLines, snippet } from "./helpers";

const Input = z.object({
	query: z.string().min(2),
	docs: z.array(z.string()).optional(),
});

/** Procura a query nos docs do brief e devolve 2 KB de contexto. */
export class DocContextTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "doc_context",
		description: "Trechos de documentação relevantes para a revisão.",
		category: "context",
		capabilities: ["docs", "search"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 120_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const guard = new PathGuard(context.repoRoot);
		const docs = input.docs ?? [...context.agent.docs];
		const needle = input.query.toLowerCase();
		const matches: unknown[] = [];
		const evidence: import("../../investigation/evidence").Evidence[] = [];

		for (const doc of docs.slice(0, 20)) {
			let relative: string;
			try {
				relative = guard.relativePath(doc);
			} catch {
				continue;
			}
			const lines = readLines(guard.assertReadable(relative));
			if (!lines) continue;
			const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
			if (index < 0) continue;
			const start = Math.max(1, index - 2);
			const end = Math.min(lines.length, index + 12);
			matches.push({ file: relative, startLine: start, endLine: end });
			evidence.push({
				id: "",
				file: relative,
				startLine: start,
				endLine: end,
				snippet: snippet(lines, start, end).slice(0, TOOL_LIMITS.maxBytes),
				kind: "doc",
				sourceTool: "doc_context",
				confidence: 0.5,
			});
			if (matches.length >= 5) break;
		}

		return {
			ok: true,
			data: { matches },
			evidence,
			...(matches.length === 0 ? { hint: "Nenhum doc menciona a query." } : {}),
		};
	}
}
