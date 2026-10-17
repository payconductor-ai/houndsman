/**
 * Tool `find_symbol` — localiza a definição de um símbolo via AST.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";
import { TOOL_LIMITS } from "../result-limiter";
import { readLines, snippet } from "./helpers";

const Input = z.object({
	name: z.string().min(2),
	kind: z.string().optional(),
	file: z.string().optional(),
});

/** Definições encontradas (até 20), com evidência. */
export class FindSymbolTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "find_symbol",
		description: "Encontra a definição de um símbolo (AST) e o trecho curto.",
		category: "symbol",
		capabilities: ["symbol"],
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
		const definitions: unknown[] = [];
		const evidence: import("../../investigation/evidence").Evidence[] = [];

		for (const file of files.slice(0, 50)) {
			let relative: string;
			try {
				relative = guard.relativePath(file);
			} catch {
				continue;
			}
			const facts = await context.ast.factsOf(relative);
			if (!facts) continue;
			for (const symbol of facts.symbols) {
				if (!symbol.name.includes(input.name)) continue;
				if (input.kind && symbol.kind !== input.kind) continue;
				const lines = readLines(guard.assertReadable(relative)) ?? [];
				definitions.push({
					file: relative,
					name: symbol.name,
					kind: symbol.kind,
					exported: symbol.exported,
					startLine: symbol.startLine,
					endLine: symbol.endLine,
					signature: symbol.signature,
				});
				evidence.push({
					id: "",
					file: relative,
					startLine: symbol.startLine,
					endLine: Math.min(symbol.startLine + 10, symbol.endLine),
					snippet: snippet(lines, symbol.startLine, symbol.startLine + 10),
					kind: "definition",
					sourceTool: "find_symbol",
					confidence: 0.9,
				});
				if (definitions.length >= 20) break;
			}
			if (definitions.length >= 20) break;
		}

		return {
			ok: definitions.length > 0,
			data: { definitions: definitions.slice(0, 20) },
			evidence: evidence.slice(0, TOOL_LIMITS.maxResults),
			...(definitions.length === 0 ? { error: "símbolo não encontrado." } : {}),
		};
	}
}
