/**
 * Pipeline do finalize (Passo 2): findings → dedupe → estado de triagem →
 * resumo final (`review-resume.md`).
 *
 * O contexto da run entra no construtor; sem estado ambiente.
 */

import { GENERAL_WATCHDOG_ID } from "../builtins";
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
import {
	dedupeFindings,
	dedupeFindingsWithStats,
	nearbyDuplicateGroups,
	type WatchdogReport,
} from "../report-builder";
import { writeRunStatus } from "../run-status";
import { systemClock } from "../services/clock";
import { anchorReports, severityAnchoringMessages } from "../severity";
import type { Rule } from "../types";
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
 * Cobertura efetiva de um watchdog: só conta arquivos que estavam no escopo.
 *
 * `reviewedFiles` é auto-declarado pelo subagente e costuma incluir chamadores e
 * arquivos de outros domínios; sem o recorte, a tabela mostrava "25/13" e
 * escondia o que realmente ficou de fora.
 */
export function coverageOf(
	reviewedFiles: readonly string[],
	expectedFiles: readonly string[],
): { reviewed: number; expected: number } {
	const expected = new Set(expectedFiles);
	const reviewed = new Set(reviewedFiles.filter((file) => expected.has(file)));
	return { reviewed: reviewed.size, expected: expected.size };
}

/** Arquivos do escopo que não foram revisados nem declarados em `skipped`. */
export function unaccountedFiles(
	reviewedFiles: readonly string[],
	skippedFiles: readonly string[],
	expectedFiles: readonly string[],
): string[] {
	const accounted = new Set([...reviewedFiles, ...skippedFiles]);
	return expectedFiles.filter((file) => !accounted.has(file));
}

/** Arquivos do escopo declarados em `skipped` (e não revisados). */
export function skippedInScope(
	reviewedFiles: readonly string[],
	skippedFiles: readonly string[],
	expectedFiles: readonly string[],
): number {
	const reviewed = new Set(reviewedFiles);
	const expected = new Set(expectedFiles);
	return new Set(
		skippedFiles.filter((file) => expected.has(file) && !reviewed.has(file)),
	).size;
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
		.map((report) => {
			const expected = classification.watchdogs[report.watchdogId] ?? [];
			const coverage = coverageOf(report.reviewedFiles, expected);
			return {
				id: report.watchdogId,
				name: nameOf(report.watchdogId),
				findings: dedupeFindings([report]).length,
				reviewedFiles: coverage.reviewed,
				expectedFiles: coverage.expected,
				skippedFiles: skippedInScope(
					report.reviewedFiles,
					report.skipped,
					expected,
				),
			};
		})
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
		const ingested = ctx.work.readFindings(activeIds);
		const { pending, warnings } = ingested;
		messages.push(...warnings);
		// Severidade é derivada (regra declarada ou classe de impacto), nunca a escolhida
		// pelo watchdog: o mesmo código não pode sair `blocking` numa run e `attention`
		// na seguinte. Divergências são corrigidas aqui e reportadas abaixo.
		const anchored = anchorReports(ingested.reports, this.declaredRules());
		messages.push(...severityAnchoringMessages(anchored));
		const reports = anchored.reports;
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
		// O dedupe recebe o leitor: a camada por âncora precisa do conteúdo para
		// reconhecer dois achados emergentes apontando o mesmo trecho.
		const deduped = dedupeFindingsWithStats(reports, {
			readFile: ctx.files.reader(),
		});
		const merged = mergeCarryover(deduped.findings, classification.carryover ?? []);
		const emitted = reports.reduce((sum, report) => sum + report.findings.length, 0);
		const collapsed = emitted - deduped.findings.length;
		if (collapsed > 0) {
			messages.push(
				`Dedupe: ${emitted} achado(s) emitido(s) → ${deduped.findings.length} único(s) ` +
					`(${deduped.stats.collapsedByRule} por regra+arquivo, ` +
					`${deduped.stats.collapsedByAnchor} por trecho).`,
			);
		}
		// Paráfrases entre watchdogs NÃO são mescladas automaticamente: o mesmo
		// trecho pode abrigar assuntos distintos. O aviso evita que o revisor
		// trate como achados independentes o que é um defeito só.
		for (const group of nearbyDuplicateGroups(deduped.findings)) {
			const lines = group
				.map((finding) => finding.line)
				.filter((line): line is number => typeof line === "number");
			const span =
				lines.length > 0 ? `:${Math.min(...lines)}-${Math.max(...lines)}` : "";
			const watchdogs = [...new Set(group.flatMap((finding) => finding.watchdogs))];
			messages.push(
				`Possíveis duplicatas: ${group.length} achados em ${group[0].file}${span} ` +
					`(${watchdogs.join(", ")}) com descrições sobrepostas — confira se são o mesmo defeito.`,
			);
		}
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

		// Lacuna de cobertura: arquivos do escopo que ninguém declarou ter revisado.
		const gaps = reports.flatMap((report) => {
			const expected = classification.watchdogs[report.watchdogId] ?? [];
			const missing = unaccountedFiles(
				report.reviewedFiles,
				report.skipped,
				expected,
			);
			if (missing.length === 0) return [];
			return [
				{
					id: report.watchdogId,
					missing,
					coverage: coverageOf(report.reviewedFiles, expected),
				},
			];
		});
		if (gaps.length > 0) {
			const total = gaps.reduce((sum, gap) => sum + gap.missing.length, 0);
			const detail = gaps
				.map((gap) => {
					const sample = gap.missing.slice(0, 3).join(", ");
					const rest =
						gap.missing.length > 3 ? ` (+${gap.missing.length - 3})` : "";
					return `${nameOf(gap.id)} (${gap.coverage.reviewed}/${gap.coverage.expected}): ${sample}${rest}`;
				})
				.join("; ");
			messages.push(
				`Cobertura: ${total} arquivo(s) sem revisão declarada — ${detail}.`,
			);
		}

		// O staging já cumpriu o papel (briefs/findings/contexto estão no storage).
		ctx.work.clean();

		return { reportPath: location, blockers, attention, messages };
	}

	/**
	 * União das regras declaradas (todos os watchdogs ativos + o piso embutido do
	 * `general`). É a fonte da severidade dos findings de regra.
	 */
	private declaredRules(): Rule[] {
		const ids = new Set<string>([...this.config.watchdogIds, GENERAL_WATCHDOG_ID]);
		const rules: Rule[] = [];
		for (const id of ids) {
			const definition = findWatchdog(this.config, id);
			if (definition) rules.push(...definition.rules);
		}
		return rules;
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
