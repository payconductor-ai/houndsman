/**
 * Orçamento por brief (domínio) — funções puras de triagem de PRs grandes.
 *
 * Separado de `file-classifier` para que `Classification` possa aplicar o
 * orçamento sem depender do serviço de classificação.
 */

import type { ChurnMap } from "../types";

/** Churn total (adições + remoções) de um arquivo; 0 quando ausente. */
export function churnOf(filePath: string, churn: ChurnMap | undefined): number {
	const entry = churn?.[filePath];
	return entry ? entry.additions + entry.deletions : 0;
}

/** Ordena os arquivos por risco (churn desc; empate pelo caminho). */
export function sortByRisk(files: readonly string[], churn?: ChurnMap): string[] {
	return [...files].sort((a, b) => {
		const delta = churnOf(b, churn) - churnOf(a, churn);
		return delta !== 0 ? delta : a.localeCompare(b);
	});
}

/** Resultado da aplicação do orçamento: o que revisar e o que ficou de fora. */
export type BudgetSelection = { selected: string[]; overflow: string[] };

/**
 * Aplica o orçamento por brief: mantém os `maxFiles` de maior risco e devolve o
 * restante em `overflow` (nunca descarta silenciosamente). `maxFiles` não-positivo
 * ou não-finito desativa o orçamento.
 */
export function selectByBudget(
	files: readonly string[],
	churn: ChurnMap | undefined,
	maxFiles: number,
): BudgetSelection {
	const ordered = sortByRisk(files, churn);
	if (!Number.isFinite(maxFiles) || maxFiles <= 0 || ordered.length <= maxFiles) {
		return { selected: ordered, overflow: [] };
	}
	return { selected: ordered.slice(0, maxFiles), overflow: ordered.slice(maxFiles) };
}
