/**
 * Tool `tests_for_symbol` — arquivos de teste relacionados a um símbolo.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { TOOL_LIMITS } from "../result-limiter";
import { gitGrep, parseGrepLine } from "./helpers";

const Input = z.object({ symbol: z.string().min(2), file: z.string().optional() });

const TEST_PATHSPECS = [
	"*.test.*",
	"*.spec.*",
	"**/__tests__/**",
	"**/tests/**",
	"**/test/**",
];

/** Referências em arquivos de teste (até 20 arquivos). */
export class TestsForSymbolTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "tests_for_symbol",
		description: "Arquivos de teste que mencionam um símbolo.",
		category: "evidence",
		capabilities: ["tests", "search"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 120_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const args = ["-n", "-I", "-F", "-w", "-e", input.symbol];
		if (input.file) args.push("--", input.file);
		else args.push("--", ...TEST_PATHSPECS);
		const result = gitGrep(context.repoRoot, args);
		if (!result.ok) return { ok: true, data: { files: [], references: [] } };
		const references = result.stdout
			.split("\n")
			.map(parseGrepLine)
			.filter((line): line is NonNullable<typeof line> => line !== null)
			.slice(0, TOOL_LIMITS.maxResults);
		const files = [...new Set(references.map((line) => line.file))].slice(0, 20);
		const evidence = references.slice(0, 10).map((line) => ({
			id: "",
			file: line.file,
			startLine: line.line,
			endLine: line.line,
			snippet: line.text,
			kind: "test" as const,
			sourceTool: "tests_for_symbol",
			confidence: 0.6,
		}));
		return { ok: true, data: { files, references }, evidence };
	}
}
