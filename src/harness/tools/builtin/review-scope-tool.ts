/**
 * Tool `review_scope` — escopo do diff (símbolos e faixas alteradas).
 *
 * É a fonte de verdade para o agente decidir onde investigar: código fora das
 * faixas é contexto, não pode virar finding.
 */

import { z } from "zod";
import { formatRanges, formatSymbols, summarizeScope } from "../../../core/changed-scope";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";

const Input = z.object({ file: z.string().optional() });

/** Faixas e símbolos alterados por arquivo do domínio. */
export class ReviewScopeTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "review_scope",
		description:
			"Escopo do diff: faixas e símbolos alterados (só o que pode virar finding).",
		category: "context",
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
		const { changedScope, files } = context.agent;
		const selected = input.file ? [input.file] : [...files];
		const entries = selected.flatMap((file) => {
			const entry = changedScope[file];
			if (!entry) return [];
			return [
				{
					file,
					source: entry.source,
					ranges: entry.ranges,
					symbols: entry.symbols,
					lines: formatRanges(entry.ranges),
					symbolsText: formatSymbols(entry.symbols),
				},
			];
		});
		const totals = summarizeScope(
			Object.fromEntries(
				entries.map((entry) => [
					entry.file,
					{
						ranges: entry.ranges,
						symbols: entry.symbols,
						source: entry.source,
					},
				]),
			),
		);
		return {
			ok: true,
			data: { files: entries, totals },
			...(entries.length === 0
				? {
						hint: "Sem faixas alteradas para o filtro: use o arquivo apenas como contexto e não reporte achados de linha.",
					}
				: {}),
		};
	}
}
