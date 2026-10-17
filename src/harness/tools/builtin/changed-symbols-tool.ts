/**
 * Tool `changed_symbols` — delta AST da revisão (o que realmente mudou).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";

const Input = z.object({ file: z.string().optional() });

/** Símbolos adicionados/removidos/modificados e assinaturas alteradas. */
export class ChangedSymbolsTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "changed_symbols",
		description: "Delta AST da revisão: símbolos adicionados/removidos/modificados.",
		category: "ast",
		capabilities: ["ast"],
		readOnly: true,
		cost: 1,
		cacheTtlMs: 300_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const entries = [];
		for (const [file, analysis] of context.agent.ast) {
			if (input.file && file !== input.file) continue;
			if (!analysis.delta) continue;
			entries.push({
				file,
				added: analysis.delta.addedSymbols.map((symbol) => symbol.name),
				removed: analysis.delta.removedSymbols.map((symbol) => symbol.name),
				modified: analysis.delta.modifiedSymbols.map((symbol) => symbol.name),
				changedSignatures: analysis.delta.changedSignatures,
				addedImports: analysis.delta.addedImports,
				removedImports: analysis.delta.removedImports,
			});
		}
		return {
			ok: true,
			data: { files: entries },
			...(entries.length === 0 ? { hint: "Sem delta AST para os filtros." } : {}),
		};
	}
}
