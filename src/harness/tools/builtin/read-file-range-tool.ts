/**
 * Tool `read_file_range` — lê um trecho explícito (nunca o arquivo inteiro).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";
import { TOOL_LIMITS } from "../result-limiter";
import { readLines, readRange } from "./helpers";

const Input = z.object({
	path: z.string().min(1),
	startLine: z.number().int().min(1),
	endLine: z.number().int().min(1),
});

/** Leitura por faixa, com no máximo 200 linhas/32 KB. */
export class ReadFileRangeTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "read_file_range",
		description: "Lê um trecho de arquivo (faixa obrigatória, até 200 linhas).",
		category: "code",
		capabilities: ["read"],
		readOnly: true,
		cost: 3,
		cacheTtlMs: 60_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const guard = new PathGuard(context.repoRoot);
		try {
			const range = readRange(guard, input.path, input.startLine, input.endLine);
			if (!range) return { ok: false, error: "arquivo ilegível." };
			const lines = readLines(guard.assertReadable(input.path)) ?? [];
			const evidence = {
				id: "",
				file: range.path,
				startLine: range.startLine,
				endLine: range.endLine,
				snippet: lines.slice(range.startLine - 1, range.endLine).join("\n"),
				kind: "diff" as const,
				sourceTool: "read_file_range",
				confidence: 0.6,
			};
			return {
				ok: true,
				data: range,
				...(range.truncated
					? {
							truncated: true,
							hint: `Faixa limitada a ${TOOL_LIMITS.maxLines} linhas; refine o intervalo.`,
						}
					: {}),
				evidence: [
					{
						...evidence,
						snippet: evidence.snippet.slice(0, TOOL_LIMITS.maxBytes),
					},
				],
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
