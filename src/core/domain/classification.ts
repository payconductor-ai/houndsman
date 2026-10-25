/**
 * Classificação (domínio) — arquivos alterados por domínio de review.
 *
 * Envolve o `ClassificationResult` produzido pelo classificador e concentra as
 * consultas usadas pelo orquestrador (arquivos por watchdog, orçamento, churn).
 */

import type { HoundsmanPriority } from "../config";
import type { ClassificationResult } from "../file-classifier";
import type { ChurnMap } from "../types";
import { type BudgetSelection, selectByBudget } from "./budget";

/** Classificação de um diff por watchdog. */
export class Classification {
	private readonly data: ClassificationResult;

	constructor(data: ClassificationResult) {
		this.data = data;
	}

	static from(data: ClassificationResult): Classification {
		return new Classification(data);
	}

	get watchdogs(): Record<string, string[]> {
		return this.data.watchdogs;
	}

	get files(): ClassificationResult["files"] {
		return this.data.files;
	}

	get churn(): ChurnMap {
		return this.data.churn;
	}

	get unclassified(): string[] {
		return this.data.unclassified;
	}

	get excluded(): string[] {
		return this.data.excluded;
	}

	get deleted(): string[] {
		return this.data.deleted;
	}

	get stats(): Record<string, number> {
		return this.data.stats;
	}

	get excludedCount(): number {
		return this.data.excludedCount;
	}

	get base(): string | undefined {
		return this.data.base;
	}

	get head(): string | undefined {
		return this.data.head;
	}

	/** Ids de watchdog ativados (com ao menos um arquivo). */
	get activeIds(): string[] {
		return Object.keys(this.data.watchdogs);
	}

	/** Arquivos de um watchdog (vazio quando não ativado). */
	watchdogsFor(id: string): string[] {
		return this.data.watchdogs[id] ?? [];
	}

	/** Aplica o orçamento aos arquivos de um watchdog. */
	budgetFor(
		id: string,
		maxFiles: number,
		priorities?: readonly HoundsmanPriority[],
	): BudgetSelection {
		return selectByBudget(
			this.watchdogsFor(id),
			this.data.churn,
			maxFiles,
			priorities,
		);
	}

	/** Totais de churn do diff. */
	get churnTotals(): { additions: number; deletions: number } {
		let additions = 0;
		let deletions = 0;
		for (const entry of Object.values(this.data.churn ?? {})) {
			additions += entry.additions;
			deletions += entry.deletions;
		}
		return { additions, deletions };
	}

	/** Payload serializável (mesmo shape do `classification.json`). */
	toJSON(): ClassificationResult {
		return this.data;
	}
}
