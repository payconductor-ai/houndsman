/**
 * Orçamento por brief (domínio) — funções puras de triagem de PRs grandes.
 *
 * Separado de `file-classifier` para que `Classification` possa aplicar o
 * orçamento sem depender do serviço de classificação.
 */

import type { HoundsmanPriority } from "../config";
import type { ChurnMap } from "../types";

/** Churn total (adições + remoções) de um arquivo; 0 quando ausente. */
export function churnOf(filePath: string, churn: ChurnMap | undefined): number {
	const entry = churn?.[filePath];
	return entry ? entry.additions + entry.deletions : 0;
}

/** Regra de prioridade do caminho (a primeira que casar vence). */
export function priorityFor(
	filePath: string,
	priorities: readonly HoundsmanPriority[] | undefined,
): HoundsmanPriority | undefined {
	for (const rule of priorities ?? []) {
		// Regex global mantém `lastIndex` entre chamadas — zera para não pular match.
		if (rule.pattern.global) rule.pattern.lastIndex = 0;
		if (rule.pattern.test(filePath)) return rule;
	}
	return undefined;
}

/** Bônus da regra (linhas de churn equivalentes; ausente/inválido = 0). */
function bonusOf(rule: HoundsmanPriority | undefined): number {
	const bonus = rule?.bonus;
	return bonus !== undefined && Number.isFinite(bonus) ? Math.max(0, bonus) : 0;
}

/** Bônus de prioridade do caminho (primeira regra que casar vence). */
export function priorityBonus(
	filePath: string,
	priorities: readonly HoundsmanPriority[] | undefined,
): number {
	return bonusOf(priorityFor(filePath, priorities));
}

/** Teto de churn da regra (ausente/inválido = sem teto). */
function churnLimitOf(rule: HoundsmanPriority | undefined): number {
	const limit = rule?.maxRiskFromChurn;
	return limit !== undefined && Number.isFinite(limit) && limit > 0
		? limit
		: Number.POSITIVE_INFINITY;
}

/**
 * Risco do arquivo: `min(churn, maxRiskFromChurn) + bonus`.
 *
 * O teto existe para superchurn de caminho de baixa criticidade (frontend que
 * reformatou uma tabela inteira) não competir com churn real de caminho crítico;
 * abaixo do teto, o peso do caminho é o churn natural.
 */
export function riskOf(
	filePath: string,
	churn: ChurnMap | undefined,
	priorities?: readonly HoundsmanPriority[],
): number {
	const rule = priorityFor(filePath, priorities);
	const churnRisk = Math.min(churnOf(filePath, churn), churnLimitOf(rule));
	return churnRisk + bonusOf(rule);
}

/** Ordena os arquivos por risco (churn + prioridade; empate pelo caminho). */
export function sortByRisk(
	files: readonly string[],
	churn?: ChurnMap,
	priorities?: readonly HoundsmanPriority[],
): string[] {
	return [...files].sort((a, b) => {
		const delta = riskOf(b, churn, priorities) - riskOf(a, churn, priorities);
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
	priorities?: readonly HoundsmanPriority[],
): BudgetSelection {
	const ordered = sortByRisk(files, churn, priorities);
	if (!Number.isFinite(maxFiles) || maxFiles <= 0 || ordered.length <= maxFiles) {
		return { selected: ordered, overflow: [] };
	}
	return { selected: ordered.slice(0, maxFiles), overflow: ordered.slice(maxFiles) };
}
