/**
 * Tool `file_outline` — mapa de símbolos do arquivo (sem corpo).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";

const Input = z.object({ path: z.string().min(1) });

/** Metadados + imports/exports + símbolos do arquivo. */
export class FileOutlineTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "file_outline",
		description: "Mapa de símbolos, imports e exports de um arquivo (sem corpo).",
		category: "symbol",
		capabilities: ["outline", "ast"],
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
		let path: string;
		try {
			path = guard.relativePath(input.path);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const facts = await context.ast.factsOf(path);
		if (!facts) {
			return {
				ok: false,
				error: "AST indisponível para este arquivo (grammar/língua).",
				hint: "Use read_file_range para inspecionar o trecho.",
			};
		}
		return {
			ok: true,
			data: {
				path,
				language: facts.language,
				symbols: facts.symbols.map((symbol) => ({
					name: symbol.name,
					kind: symbol.kind,
					exported: symbol.exported,
					startLine: symbol.startLine,
					endLine: symbol.endLine,
					signature: symbol.signature,
				})),
				imports: facts.imports,
				exports: facts.exports,
				decorators: facts.decorators,
			},
		};
	}
}
