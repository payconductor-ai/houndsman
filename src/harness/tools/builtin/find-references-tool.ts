/**
 * Tool `find_references` — usos/chamadas de um símbolo via `git grep`.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { TOOL_LIMITS } from "../result-limiter";
import { gitGrep, parseGrepLine } from "./helpers";

const Input = z.object({
	symbol: z.string().min(2),
	file: z.string().optional(),
});

/** Até 50 referências com arquivo/linha/trecho. */
export class FindReferencesTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "find_references",
		description: "Procura usos/chamadas de um símbolo (até 50 referências).",
		category: "symbol",
		capabilities: ["references", "search"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 60_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const args = ["-n", "-I", "-F", "-w", "-e", input.symbol];
		if (input.file) args.push("--", input.file);
		const result = gitGrep(context.repoRoot, args);
		if (!result.ok) {
			return { ok: true, data: { references: [], truncated: false } };
		}
		const lines = result.stdout.split("\n").map(parseGrepLine);
		const references = lines
			.filter((line): line is NonNullable<typeof line> => line !== null)
			.slice(0, TOOL_LIMITS.maxResults)
			.map((line) => ({
				file: line.file,
				line: line.line,
				text: line.text.slice(0, 200),
			}));
		const evidence = references.slice(0, 10).map((reference) => ({
			id: "",
			file: reference.file,
			startLine: reference.line,
			endLine: reference.line,
			snippet: reference.text,
			kind: "reference" as const,
			sourceTool: "find_references",
			confidence: 0.7,
		}));
		const truncated = lines.length > references.length;
		return {
			ok: true,
			data: { references, truncated },
			evidence,
			...(truncated ? { truncated: true, hint: "Refine com file." } : {}),
		};
	}
}
