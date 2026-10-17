/**
 * Tool `symbol_context` — definição + janela curta do corpo + referências.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";
import { TOOL_LIMITS } from "../result-limiter";
import { gitGrep, numberedRange, parseGrepLine, readLines, snippet } from "./helpers";

const Input = z.object({
	symbol: z.string().min(2),
	file: z.string().optional(),
});

/** Devolve no máximo ~120 linhas do símbolo (nunca o arquivo inteiro). */
export class SymbolContextTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "symbol_context",
		description: "Definição + assinatura + corpo curto + referências de um símbolo.",
		category: "symbol",
		capabilities: ["symbol", "read"],
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
		const files = input.file
			? [input.file]
			: [
					...new Set([
						...context.agent.files,
						...(context.agent.impact?.affectedFiles ?? []),
					]),
				];
		const maxLines = Math.min(TOOL_LIMITS.maxLines, 120);

		for (const file of files.slice(0, 50)) {
			let relative: string;
			try {
				relative = guard.relativePath(file);
			} catch {
				continue;
			}
			const facts = await context.ast.factsOf(relative);
			if (!facts) continue;
			const symbol = facts.symbols.find((item) => item.name === input.symbol);
			if (!symbol) continue;

			const lines = readLines(guard.assertReadable(relative)) ?? [];
			const endLine = Math.min(symbol.endLine, symbol.startLine + maxLines - 1);
			const references = referencesOf(context.repoRoot, input.symbol);
			return {
				ok: true,
				data: {
					file: relative,
					name: symbol.name,
					kind: symbol.kind,
					exported: symbol.exported,
					signature: symbol.signature,
					startLine: symbol.startLine,
					endLine,
					truncatedBody: symbol.endLine > endLine,
					body: numberedRange(lines, symbol.startLine, endLine),
					references,
				},
				evidence: [
					{
						id: "",
						file: relative,
						startLine: symbol.startLine,
						endLine,
						snippet: snippet(lines, symbol.startLine, endLine),
						kind: "definition",
						sourceTool: "symbol_context",
						confidence: 0.9,
					},
				],
			};
		}
		return {
			ok: false,
			error: `símbolo '${input.symbol}' não encontrado (AST).`,
			hint: "Use search_code/find_references.",
		};
	}
}

/** Referências resumidas (arquivo:linha). */
function referencesOf(root: string, symbol: string): { file: string; line: number }[] {
	const result = gitGrep(root, ["-n", "-I", "-F", "-w", "-e", symbol]);
	if (!result.ok) return [];
	return result.stdout
		.split("\n")
		.map(parseGrepLine)
		.filter((line): line is NonNullable<typeof line> => line !== null)
		.slice(0, 20)
		.map((line) => ({ file: line.file, line: line.line }));
}
