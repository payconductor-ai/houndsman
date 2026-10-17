/**
 * Manifesto da run (biblioteca) — monta e grava o `manifest.json`.
 *
 * Concentra o resumo do que foi ativado (watchdogs, orçamento, churn, contexto,
 * Jev e incremental), hoje espalhado em helpers do orquestrador.
 */

import { Classification } from "../domain/classification";
import type { ClassificationResult } from "../file-classifier";
import type { JevCandidatesFile } from "../jev";
import { OUTPUT_FORMAT_PATH, relFromRoot } from "../paths";
import { readContextSummary } from "../pr-context";
import type { ProjectConfig } from "../project-config";
import type { MergedFinding } from "../report-builder";
import type { RunLayout } from "../run-layout";
import { systemClock } from "../services/clock";
import { ProjectFiles } from "../services/project-files";

/** Opções do manifesto (subset do `ReviewOptions`). */
export type ManifestOptions = {
	base: string;
	head: string;
};

/** Classificação enriquecida gravada pelo prepare (modo + incremental). */
export type ManifestClassification = ClassificationResult & {
	headSha?: string;
	mode: "full" | "incremental";
	reviewedFrom?: string;
	carryover?: MergedFinding[];
};

/** Escreve o `manifest.json` de uma run. */
export class ManifestWriter {
	private readonly layout: RunLayout;
	private readonly project: ProjectConfig;
	private readonly options: ManifestOptions;

	constructor(layout: RunLayout, project: ProjectConfig, options: ManifestOptions) {
		this.layout = layout;
		this.project = project;
		this.options = options;
	}

	write(
		classification: ManifestClassification,
		activeIds: string[],
		pending: string[],
		jev: JevCandidatesFile,
	): void {
		const view = Classification.from(classification);
		const maxFilesPerBrief = this.project.maxFilesPerBrief;
		let filesOverBudget = 0;

		const watchdogs = activeIds.map((id) => {
			const selection = view.budgetFor(id, maxFilesPerBrief);
			filesOverBudget += selection.overflow.length;
			return {
				id,
				name: this.project.watchdogs.nameOf(id),
				files: selection.selected,
				overflow: selection.overflow.length,
				brief: relFromRoot(this.layout.briefFile(id)),
				findings: relFromRoot(this.layout.findingFile(id)),
				status: pending.includes(id) ? "pending" : "done",
			};
		});

		const summary = readContextSummary(this.layout.contextPaths.summary);
		const manifest = {
			branch: this.layout.branch,
			slug: this.layout.slug,
			base: this.options.base,
			head: this.options.head,
			headSha: classification.headSha,
			generatedAt: systemClock(),
			outputFormat: OUTPUT_FORMAT_PATH,
			budget: { maxFilesPerBrief, filesOverBudget },
			churn: view.churnTotals,
			incremental:
				classification.mode === "incremental"
					? {
							from: classification.reviewedFrom,
							changedFiles: Object.keys(classification.files).length,
							carried: classification.carryover?.length ?? 0,
						}
					: undefined,
			watchdogs,
			context: summary
				? { summarized: true, source: summary.source ?? null }
				: { summarized: false, source: null },
			jev: jev.available
				? {
						available: true,
						model: jev.model,
						threshold: jev.threshold,
						analyzedFiles: jev.analyzedFiles,
						candidates: jev.candidates.length,
						skipped: jev.skipped?.length ?? 0,
					}
				: { available: false, reason: jev.reason },
			deleted: classification.deleted,
			unclassified: classification.unclassified,
			excludedCount: classification.excludedCount,
		};

		new ProjectFiles().write(
			this.layout.manifestFile,
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
	}
}
