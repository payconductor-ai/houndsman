/**
 * Apresentação do lote de correção (biblioteca) — markdown do `findings batch`.
 */

import type { FixBatchResult } from "../fix-batch";
import { FindingsPresenter } from "./findings-presenter";

/** Renderiza o grupo atual paginado + os outros grupos disponíveis. */
export class BatchPresenter {
	private readonly findings = new FindingsPresenter();

	render(result: FixBatchResult): string {
		const { dimension, current, others, totals } = result;
		if (totals.queue === 0) return "Nenhum finding pendente de correção.";

		const lines = [
			`# Lote de correção — agrupado por ${dimension} (${totals.groups} grupo(s))`,
			"",
			`## Grupo atual — ${current.key} (${current.total} finding(s), mostrando ${current.returned})`,
		];
		for (const finding of current.findings)
			lines.push(...this.findings.line(finding));
		if (current.remaining > 0) {
			lines.push("", `_… +${current.remaining} neste grupo (use \`--offset\`)._`);
		}
		if (others.length > 0) {
			lines.push("", "## Outros grupos disponíveis");
			for (const group of others) {
				lines.push(
					`- ${group.key} — ${group.count} (${this.findings.severityBreakdown(group.bySeverity)})`,
				);
			}
		}
		lines.push(
			"",
			`fila: ${totals.queue} · retornados: ${totals.returned} · grupos: ${totals.groups}`,
		);
		return lines.join("\n");
	}
}
