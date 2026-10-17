/**
 * Tool `search_code` — localiza padrões via `git grep` e devolve snippets.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { TOOL_LIMITS } from "../result-limiter";
import { gitGrep, parseGrepLine } from "./helpers";

const Input = z.object({
	query: z.string().min(2),
	mode: z.enum(["fixed", "regex"]).optional(),
	path: z.string().optional(),
	contextLines: z.number().int().min(0).max(3).optional(),
	maxResults: z.number().int().min(1).max(50).optional(),
});

/** Busca com limite de resultados e snippets curtos. */
export class SearchCodeTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "search_code",
		description: "Procura um padrão no código (até 50 resultados com snippet).",
		category: "code",
		capabilities: ["search"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 60_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const mode = input.mode === "regex" ? "-E" : "-F";
		const args = ["-n", "-I", mode, "-e", input.query];
		if (input.path) args.push("--", input.path);
		const result = gitGrep(context.repoRoot, args);
		if (!result.ok) {
			// `git grep` retorna 1 quando não há match (não é erro).
			if (result.stderr.includes("exit") || result.stdout === "") {
				return { ok: true, data: { results: [], truncated: false } };
			}
			return { ok: false, error: result.stderr || "falha no git grep." };
		}
		const max = input.maxResults ?? TOOL_LIMITS.maxResults;
		const results = result.stdout
			.split("\n")
			.map(parseGrepLine)
			.filter((line): line is NonNullable<typeof line> => line !== null)
			.slice(0, max)
			.map((line) => ({
				file: line.file,
				line: line.line,
				text: line.text.slice(0, 240),
			}));
		const truncated = result.stdout.trim().split("\n").length > results.length;
		return {
			ok: true,
			data: { results, truncated },
			...(truncated ? { truncated: true, hint: "Refine a query/path." } : {}),
		};
	}
}
