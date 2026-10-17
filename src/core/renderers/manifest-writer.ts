/**
 * Manifesto da run (biblioteca) — monta e grava o artefato `manifest.json`.
 *
 * Concentra o resumo do que foi ativado (watchdogs, orçamento, churn, contexto,
 * Jev e incremental). O manifesto vive no storage; os caminhos de briefs e
 * findings apontam para o staging da review.
 */

import type { AiUsage } from "../ai/types";
import { Classification } from "../domain/classification";
import type { ClassificationResult } from "../file-classifier";
import type { JevCandidatesFile } from "../jev";
import { OUTPUT_FORMAT_PATH } from "../paths";
import type { ProjectConfig } from "../project-config";
import type { MergedFinding } from "../report-builder";
import { systemClock } from "../services/clock";
import type { ReviewRecord, StorageProvider } from "../storage/types";
import type { ReviewWorkArea } from "../storage/work-area";

/** Opções do manifesto (subset do `ReviewOptions`). */
export type ManifestOptions = {
	base: string;
	head: string;
};

/** Resumo do AST no manifesto. */
export type ManifestAst = {
	enabled: boolean;
	languages: string[];
	files: number;
	impact: {
		affectedFiles: number;
		importers: number;
		exportedChanges: number;
	};
};

/** Resumo da IA no manifesto (só quando a IA foi usada). */
export type ManifestAi = {
	enabled: boolean;
	provider: string;
	model: string;
	briefPlans: number;
	usage: AiUsage;
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
	private readonly storage: StorageProvider;
	private readonly review: ReviewRecord;
	private readonly work: ReviewWorkArea;
	private readonly project: ProjectConfig;
	private readonly options: ManifestOptions;

	constructor(
		storage: StorageProvider,
		review: ReviewRecord,
		work: ReviewWorkArea,
		project: ProjectConfig,
		options: ManifestOptions,
	) {
		this.storage = storage;
		this.review = review;
		this.work = work;
		this.project = project;
		this.options = options;
	}

	write(
		classification: ManifestClassification,
		activeIds: string[],
		pending: string[],
		jev: JevCandidatesFile,
		ast?: ManifestAst,
		ai?: ManifestAi,
	): void {
		const view = Classification.from(classification);
		const maxFilesPerBrief = this.project.maxFilesPerBrief;
		let filesOverBudget = 0;

		const watchdogs = activeIds.map((id) => {
			const selection = view.budgetFor(id, maxFilesPerBrief);
			filesOverBudget += selection.overflow.length;
			const domain = this.project.watchdogs.find(id);
			return {
				id,
				name: this.project.watchdogs.nameOf(id),
				...(domain?.definition.fallback ? { fallback: true } : {}),
				files: selection.selected,
				overflow: selection.overflow.length,
				brief: this.work.briefFile(id),
				findings: this.work.findingFile(id),
				status: pending.includes(id) ? "pending" : "done",
			};
		});

		const summary = this.work.readContextSummary();
		const manifest = {
			branch: this.review.branch,
			slug: this.review.slug,
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
			ast: ast ?? {
				enabled: false,
				languages: [],
				files: 0,
				impact: { affectedFiles: 0, importers: 0, exportedChanges: 0 },
			},
			ai,
			deleted: classification.deleted,
			unclassified: classification.unclassified,
			excludedCount: classification.excludedCount,
		};

		this.storage.writeArtifact(this.review.id, {
			name: "manifest.json",
			kind: "manifest",
			content: `${JSON.stringify(manifest, null, 2)}\n`,
		});
	}
}
