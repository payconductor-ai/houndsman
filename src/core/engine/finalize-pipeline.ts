/**
 * Pipeline do finalize (Passo 2): findings → dedupe → estado de triagem →
 * resumo final (`review-resume.md`).
 *
 * O contexto da run entra no construtor; sem estado ambiente.
 */

import { summarizeBusiness } from "../business-summary";
import type { HoundsmanConfig } from "../config";
import { buildStateFromFindings } from "../findings-state";
import { syncResolvedThreads } from "../github-review";
import type { JevCandidatesFile } from "../jev";
import { displayPath, OUTPUT_FORMAT_PATH, REVIEW_RESUME_FILE } from "../paths";
import { ProjectConfig } from "../project-config";
import {
	type ManifestAi,
	type ManifestAst,
	type ManifestBusiness,
	ManifestWriter,
} from "../renderers/manifest-writer";
import { type ResumeDomain, renderReviewResume } from "../renderers/resume-renderer";
import { dedupeFindings, type WatchdogReport } from "../report-builder";
import { writeRunStatus } from "../run-status";
import { systemClock } from "../services/clock";
import { findWatchdog } from "../watchdog-registry";
import { mergeCarryover } from "./carryover";
import type { ReviewContext } from "./review-context";
import type { ReviewOptions } from "./review-options";
import type { RunClassification } from "./review-scope";
import { RunArtifacts } from "./run-artifacts";
import { shortSha } from "./run-format";

/** Aviso no topo do resumo quando a revisão foi incremental (senão vazio). */
function incrementalNote(classification: RunClassification): string {
	if (classification.mode !== "incremental" || !classification.reviewedFrom) return "";
	const carried = classification.carryover?.length ?? 0;
	return (
		`> **Revisão incremental** — desde \`${shortSha(classification.reviewedFrom)}\`; ` +
		`${Object.keys(classification.files).length} arquivo(s) alterado(s), ` +
		`${carried} finding(s) carregado(s) do review anterior.\n\n`
	);
}

/**
 * Cobertura por domínio (achados × arquivos revisados/esperados) para a tabela
 * do resumo final. Não grava relatório por domínio: os achados vivem na triagem
 * (`findings`), que já é filtrável por watchdog na UI.
 */
function summarizeDomains(
	reports: readonly WatchdogReport[],
	classification: RunClassification,
	nameOf: (id: string) => string,
): ResumeDomain[] {
	return reports
		.map((report) => ({
			id: report.watchdogId,
			name: nameOf(report.watchdogId),
			findings: dedupeFindings([report]).length,
			reviewedFiles: report.reviewedFiles.length,
			expectedFiles: (classification.watchdogs[report.watchdogId] ?? []).length,
		}))
		.sort((a, b) => b.findings - a.findings || a.name.localeCompare(b.name));
}

export type FinalizeResult = {
	reportPath: string;
	blockers: number;
	attention: number;
	messages: string[];
};

/**
 * Passo 2 — consolida os findings no resumo final (`review-resume.md`).
 * Lança se houver findings pendentes (o CLI decide o exit code).
 */
export class FinalizePipeline {
	private readonly artifacts: RunArtifacts;

	constructor(
		private readonly ctx: ReviewContext,
		private readonly config: HoundsmanConfig,
		private readonly opts: ReviewOptions,
	) {
		this.artifacts = new RunArtifacts(ctx.storage, ctx.review, ctx.work);
	}

	run(): FinalizeResult {
		const { ctx, config, opts } = this;
		const branch = ctx.review.branch;
		// `--finalize` só consolida um ciclo preparado (status `reviewing`). Sem esta
		// guarda, um prepare no-op seguido de `--finalize` reescreveria o resumo
		// anterior com a classificação antiga (perdendo a cobertura por domínio).
		// O `ctx.review` é um snapshot: relê o status atual do storage.
		const status = ctx.storage.getReview(ctx.review.id)?.status ?? null;
		if (status !== "reviewing") {
			const state = ctx.storage.readFindings(ctx.review.id);
			const present = Object.values(state?.findings ?? {}).filter(
				(finding) => finding.present,
			);
			return {
				reportPath: ctx.storage.location(ctx.review.id),
				blockers: present.filter((f) => f.severity === "blocking").length,
				attention: present.filter((f) => f.severity === "attention").length,
				messages: [
					`Nada a finalizar: nenhum ciclo de revisão pendente (status: ${status ?? "sem status"}).`,
					"Se nada mudou desde a última revisão, o resumo anterior foi mantido; use `--full` para re-revisar.",
				],
			};
		}

		const classification = this.artifacts.classification();
		const activeIds = Object.keys(classification.watchdogs);

		const messages: string[] = [];
		const { reports, pending, warnings } = ctx.work.readFindings(activeIds);
		messages.push(...warnings);
		const jev = this.artifacts.candidates(config);
		const extras = this.artifacts.manifestExtras();
		const business = this.artifacts.persistBusiness();
		const manifestBusiness: ManifestBusiness | undefined = business
			? { source: business.source, ...summarizeBusiness(business) }
			: extras.business;
		this.writeManifest(
			classification,
			activeIds,
			pending,
			jev,
			extras.ast,
			extras.ai,
			manifestBusiness,
		);

		if (pending.length > 0) {
			throw new Error(
				`Faltam ${pending.length}/${activeIds.length} findings: ${pending.join(", ")}.\n` +
					`Cada watchdog deve gravar ${displayPath(ctx.work.findingsDir)}/<id>.json (schema ${OUTPUT_FORMAT_PATH}).`,
			);
		}

		const now = systemClock();
		// Findings re-reportados neste ciclo + carry-over (arquivos inalterados).
		const merged = mergeCarryover(
			dedupeFindings(reports),
			classification.carryover ?? [],
		);
		if (classification.mode === "incremental") {
			messages.push(
				`Carry-over: ${classification.carryover?.length ?? 0} finding(s) preservado(s) de ${shortSha(classification.reviewedFrom ?? "")}.`,
			);
		}

		// Estado de triagem: preserva o que já existia (casando por fingerprint) e
		// anexa o `id` de cada finding aos itens do relatório. A linha é cache —
		// recalculada por `houndsman findings sync` após edições. O commit revisado
		// (`reviewed.headSha`) habilita o review incremental e o diff focado do verify.
		const state = buildStateFromFindings(merged, {
			branch,
			readFile: ctx.files.reader(),
			previous: ctx.storage.readFindings(ctx.review.id),
			reviewedPaths: new Set([
				...reports.flatMap((report) => report.reviewedFiles),
				// Arquivo deletado: o achado deixou de existir junto com ele.
				...classification.deleted,
			]),
			now,
			headSha: classification.headSha,
			reviewed: classification.headSha
				? { headSha: classification.headSha, at: now }
				: undefined,
		});

		// Findings corrigidos entre revisões (ausentes + done) têm a conversa do PR
		// resolvida automaticamente; as já resolvidas no GitHub são puladas. Só
		// toca o `gh` quando há vínculo remoto pendente (fail-open).
		const threadIds = Object.values(state.findings)
			.filter(
				(finding) =>
					!finding.present &&
					finding.execState === "done" &&
					finding.github &&
					finding.github.kind !== "comment" &&
					!finding.github.resolvedAt,
			)
			.map((finding) => finding.id);
		if (threadIds.length > 0) {
			const sync = syncResolvedThreads({ state, ids: threadIds, now });
			if (!sync.available) {
				messages.push(`GitHub: threads não sincronizadas (${sync.reason}).`);
			} else if (sync.checked > 0) {
				const failures =
					sync.failed.length > 0 ? `, ${sync.failed.length} falha(s)` : "";
				messages.push(
					`GitHub: ${sync.resolved.length} thread(s) resolvida(s), ${sync.skipped.length} já resolvida(s)/pulada(s)${failures}.`,
				);
			}
		}

		ctx.storage.writeFindings(ctx.review.id, state);
		ctx.storage.updateReview(ctx.review.id, {
			base: opts.base,
			head: opts.head,
			headSha: classification.headSha,
		});
		writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });

		this.artifacts.persistContext();
		const context = ctx.work.readContextSummary() ?? this.artifacts.contextSummary();
		const technical =
			this.artifacts.technicalSummary() ??
			this.artifacts.technicalFallback(classification);
		const nameOf = (id: string): string => findWatchdog(config, id)?.name ?? id;
		const domains = summarizeDomains(reports, classification, nameOf);
		// Resumo final — único artefato humano: negócio, técnico, cobertura e
		// conclusão. Os achados ficam na triagem (storage/UI), não duplicados aqui.
		ctx.storage.writeArtifact(ctx.review.id, {
			name: REVIEW_RESUME_FILE,
			kind: "resume",
			content: renderReviewResume({
				branch,
				date: now.slice(0, 10),
				note: incrementalNote(classification),
				context,
				business,
				classification,
				findings: merged,
				technical,
				domains,
				candidates: jev.available ? jev.candidates : undefined,
			}),
		});

		const location = ctx.storage.location(ctx.review.id);
		messages.push(
			`Triagem: ${location} — ${Object.keys(state.findings).length} finding(s).`,
		);

		const blockers = merged.filter((f) => f.severity === "blocking").length;
		const attention = merged.filter((f) => f.severity === "attention").length;
		messages.push(
			`Resumo: ${location} (${REVIEW_RESUME_FILE}) — ${blockers} bloqueante(s), ${attention} atenção.`,
		);

		// O staging já cumpriu o papel (briefs/findings/contexto estão no storage).
		ctx.work.clean();

		return { reportPath: location, blockers, attention, messages };
	}

	/** Grava o manifesto da run (delegado ao `ManifestWriter`). */
	private writeManifest(
		classification: RunClassification,
		activeIds: string[],
		pending: string[],
		jev: JevCandidatesFile,
		ast?: ManifestAst,
		ai?: ManifestAi,
		business?: ManifestBusiness,
	): void {
		new ManifestWriter(
			this.ctx.storage,
			this.ctx.review,
			this.ctx.work,
			new ProjectConfig(this.config),
			this.opts,
		).write(classification, activeIds, pending, jev, ast, ai, business);
	}
}
