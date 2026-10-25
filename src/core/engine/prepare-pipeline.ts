/**
 * Pipeline do prepare (Passo 1): escopo → classificação → contexto/intenção →
 * briefs → manifesto.
 *
 * O contexto da run entra no construtor; não há estado ambiente. Duas pipelines
 * concorrentes no mesmo processo continuam isoladas.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AiClient } from "../ai/ai-client";
import { AiBriefEnricher } from "../ai/features/brief-enricher";
import { AiBusinessAnalyzer } from "../ai/features/business-analyzer";
import { AiBusinessSummarizer } from "../ai/features/business-summarizer";
import { AiClassifier } from "../ai/features/classifier";
import { AiContextSummarizer } from "../ai/features/context-summarizer";
import { AiPreAnalyzer } from "../ai/features/pre-analyzer";
import { AiTechnicalSummarizer } from "../ai/features/technical-summarizer";
import type { BriefPlan } from "../ai/schemas";
import { assetPath, OUTPUT_FORMAT_FILE } from "../assets";
import type { AstService } from "../ast/service";
import type { AstAnalysis, AstFileBrief, AstImpact } from "../ast/types";
import { GENERAL_WATCHDOG_ID } from "../builtins";
import {
	type BusinessInput,
	type BusinessSummary,
	buildBusinessBrief,
	buildBusinessSummary,
	summarizeBusiness,
} from "../business-summary";
import { summarizeScope } from "../changed-scope";
import { mapPool } from "../concurrency";
import {
	type HoundsmanConfig,
	type HoundsmanPriority,
	resolveJevConcurrency,
	resolveMaxFilesPerBrief,
} from "../config";
import {
	BRIEF_SNIPPET_FLOOR_RATIO,
	BRIEF_SNIPPET_MIN_PER_FILE,
	DEFAULT_BRIEF_SNIPPET_CHARS,
	DEFAULT_BRIEF_SNIPPET_CHARS_PER_FILE,
	GENERAL_BRIEF_SNIPPET_CHARS,
	GENERAL_BRIEF_SNIPPET_CHARS_PER_FILE,
	GENERAL_FLOW_MAX_FILES,
	GENERAL_FLOW_MIN_FILES,
	GENERAL_FLOW_MIN_LINES,
	GENERAL_FLOW_SNIPPET_CHARS_PER_FILE,
} from "../defaults";
import type { DiffSource } from "../diff-source";
import { discoverDocs } from "../doc-discoverer";
import { sortByRisk } from "../domain/budget";
import { Classification } from "../domain/classification";
import { Watchdog } from "../domain/watchdog";
import { ENV_NAMES } from "../env";
import type { BudgetSelection, ClassificationResult } from "../file-classifier";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
	serializeCandidates,
} from "../jev";
import {
	BUSINESS_BRIEF_FILE,
	BUSINESS_SUMMARY_FILE,
	displayPath,
	OUTPUT_FORMAT_PATH,
	TECHNICAL_SUMMARY_FILE,
} from "../paths";
import { type PrepareStageTiming, renderPrepareReport } from "../prepare-report";
import { ProjectConfig } from "../project-config";
import { detectPropagation, detectPropagationGaps } from "../propagation";
import { BriefRenderer } from "../renderers/brief-renderer";
import {
	type ManifestAi,
	type ManifestAst,
	type ManifestBusiness,
	ManifestWriter,
} from "../renderers/manifest-writer";
import type { ContextSummary } from "../report-builder";
import { writeRunStatus } from "../run-status";
import { systemClock } from "../services/clock";
import { buildTechnicalSummary, type TechnicalSummary } from "../technical-summary";
import type { WatchdogMeta } from "../types";
import { findWatchdog } from "../watchdog-registry";
import type { ReviewContext } from "./review-context";
import type { ReviewOptions } from "./review-options";
import {
	ReviewScopeResolver,
	type RunClassification,
	type ScopeProgress,
} from "./review-scope";
import { RunArtifacts } from "./run-artifacts";
import { shortSha } from "./run-format";

/** Resultado do prepare — mensagens para o CLI imprimir. */
export type PrepareResult = {
	messages: string[];
	/** Watchdogs ativos neste ciclo (vazio em no-op/sem arquivos). */
	activeIds: string[];
	/** Diretório dos briefs do ciclo (ausente quando não há briefs). */
	briefsDir?: string;
	/** Review do ciclo (ausente quando nada foi preparado). */
	reviewId?: string;
};

/** Etapas do prepare reportadas ao CLI (o core não escreve saída). */
export type PrepareStage =
	| "diff"
	| "ast"
	| "classify"
	| "impact"
	| "jev"
	| "context"
	| "business"
	| "technical"
	| "ai-plans"
	| "briefs"
	| "manifest";

/** Evento de progresso de uma etapa do prepare. */
export type PrepareProgressEvent =
	| { type: "start"; stage: PrepareStage }
	| { type: "done"; stage: PrepareStage; durationMs: number };

/** Callback de progresso do prepare (falhas do callback são ignoradas). */
export type PrepareProgress = (event: PrepareProgressEvent) => void;

/** Dependências opcionais do prepare (injetadas pelo engine/testes). */
export type PrepareDeps = {
	ast?: AstService;
	ai?: AiClient;
	onProgress?: PrepareProgress;
};

/** Marcador de corte no trecho (o subagente sabe que falta código). */
const SNIPPET_TRUNCATED_MARKER = "… [trecho truncado — abra o arquivo para o restante]";

/**
 * Corta o patch preservando linhas inteiras e sinalizando o corte.
 *
 * Cortar no meio de um hunk entregava diff inválido como se estivesse completo
 * — o subagente concluía sobre código que não viu.
 */
export function truncatePatch(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const room = Math.max(0, limit - SNIPPET_TRUNCATED_MARKER.length - 1);
	const head = text.slice(0, room);
	const cut = head.lastIndexOf("\n");
	return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}\n${SNIPPET_TRUNCATED_MARKER}`;
}

/**
 * Trechos do diff para o brief, distribuídos entre os arquivos.
 *
 * Metade do teto vai em partes iguais (todo arquivo revisável tem contexto); o
 * resto completa os maiores primeiro, na ordem recebida (já ordenada por
 * churn). Sem o rateio, os primeiros arquivos consumiam o teto e o subagente
 * abria os demais à mão — justamente o que o brief evita.
 */
export function buildBriefSnippets(
	files: readonly string[],
	patch: ReadonlyMap<string, string> | undefined,
	options: {
		total?: number;
		perFile?: number;
		floorRatio?: number;
		minPerFile?: number;
	} = {},
): { file: string; snippet: string }[] {
	if (!patch) return [];
	const total = options.total ?? DEFAULT_BRIEF_SNIPPET_CHARS;
	const perFile = options.perFile ?? DEFAULT_BRIEF_SNIPPET_CHARS_PER_FILE;
	const floorRatio = options.floorRatio ?? BRIEF_SNIPPET_FLOOR_RATIO;
	const minPerFile = options.minPerFile ?? BRIEF_SNIPPET_MIN_PER_FILE;

	const entries = files.flatMap((file) => {
		const text = patch.get(file);
		return text ? [{ file, text, take: 0 }] : [];
	});
	if (entries.length === 0) return [];

	const floorBudget = Math.min(total, Math.floor(total * floorRatio));
	const share = Math.max(
		minPerFile,
		Math.min(perFile, Math.floor(floorBudget / entries.length)),
	);
	let used = 0;
	for (const entry of entries) {
		entry.take = Math.min(share, entry.text.length);
		used += entry.take;
	}

	let remaining = Math.max(0, total - used);
	for (const entry of entries) {
		if (remaining <= 0) break;
		const room = Math.min(
			perFile - entry.take,
			entry.text.length - entry.take,
			remaining,
		);
		if (room <= 0) continue;
		entry.take += room;
		remaining -= room;
	}

	return entries.map((entry) => ({
		file: entry.file,
		snippet: truncatePatch(entry.text, entry.take),
	}));
}

/** Aplica o orçamento aos arquivos de um watchdog. */
function budgetFor(
	classification: ClassificationResult,
	id: string,
	maxFiles: number,
	priorities?: readonly HoundsmanPriority[],
): BudgetSelection {
	return Classification.from(classification).budgetFor(id, maxFiles, priorities);
}

/** Churn total (linhas alteradas) da PR. */
function changedLines(classification: Pick<ClassificationResult, "churn">): number {
	return Object.values(classification.churn).reduce(
		(sum, item) => sum + (item?.additions ?? 0) + (item?.deletions ?? 0),
		0,
	);
}

/**
 * `true` quando a PR é grande o bastante para o `general` revisar por fluxo.
 *
 * Amostrar 40 arquivos com ~800 chars cada não sustenta revisão de lógica:
 * o recorte por fluxo troca cobertura por profundidade nos arquivos que
 * participam dos fluxos do modelo de intenção.
 */
export function shouldSliceGeneral(
	classification: Pick<ClassificationResult, "watchdogs" | "churn">,
): boolean {
	const files = (classification.watchdogs[GENERAL_WATCHDOG_ID] ?? []).length;
	return (
		files > GENERAL_FLOW_MIN_FILES ||
		changedLines(classification) >= GENERAL_FLOW_MIN_LINES
	);
}

/**
 * Arquivos do recorte de fluxo: os citados pelos fluxos do modelo de intenção
 * primeiro, completando pelos de maior **risco** (churn + prioridade). O resto
 * vai para `overflow` (declarado em `skipped`).
 */
export function generalFlowFiles(
	classification: Pick<ClassificationResult, "watchdogs" | "churn">,
	business: BusinessSummary | null | undefined,
	maxFiles: number,
	priorities?: readonly HoundsmanPriority[],
): { selected: string[]; overflow: string[] } {
	const all = classification.watchdogs[GENERAL_WATCHDOG_ID] ?? [];
	const normalize = (value: string): string =>
		value.replace(/\\/g, "/").replace(/^\.\//, "");
	const own = new Map(all.map((file) => [normalize(file), file]));
	const flowFiles: string[] = [];
	for (const flow of business?.flows ?? []) {
		for (const file of flow.files ?? []) {
			const match = own.get(normalize(file));
			if (match && !flowFiles.includes(match)) flowFiles.push(match);
		}
	}
	const byChurn = sortByRisk(all, classification.churn, priorities);
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const file of [...flowFiles, ...byChurn]) {
		if (selected.length >= maxFiles) break;
		if (seen.has(file)) continue;
		seen.add(file);
		selected.push(file);
	}
	return { selected, overflow: all.filter((file) => !seen.has(file)) };
}

function jevSummary(jev: JevCandidatesFile): string[] {
	if (!jev.available) return [`Jev: pulado (${jev.reason}).`];
	const skipped = jev.skipped?.length ?? 0;
	return [
		`Jev: ${jev.candidates.length} candidato(s) em ${jev.analyzedFiles ?? 0} arquivo(s)` +
			(skipped > 0 ? `, ${skipped} com falha.` : "."),
	];
}

/** Lista curta das features que falharam (para a mensagem do CLI). */
function summarizeFailures(
	failures: readonly { feature: string; error: string }[],
): string {
	const byFeature = new Map<string, string>();
	for (const failure of failures) {
		if (!byFeature.has(failure.feature)) {
			byFeature.set(failure.feature, failure.error.slice(0, 120));
		}
	}
	return [...byFeature].map(([feature, error]) => `${feature} (${error})`).join("; ");
}

function discoveryMessages(
	activeIds: string[],
	classification: ClassificationResult,
	briefsDir: string,
): string[] {
	const hasGeneral = activeIds.includes(GENERAL_WATCHDOG_ID);
	const domains = activeIds.filter((id) => id !== GENERAL_WATCHDOG_ID).length;
	const label = hasGeneral
		? `${domains} watchdog(s) de domínio + revisor general`
		: `${domains} watchdog(s)`;
	const messages = [
		`Discovery: ${label}, ${Object.keys(classification.files).length} arquivo(s), ${classification.deleted.length} deletado(s).`,
		`Briefs: ${displayPath(briefsDir)}/`,
	];
	for (const file of classification.deleted) {
		messages.push(`Deletado (breaking change): ${file}`);
	}
	return messages;
}

/** Resumo do escopo — lembra que só as faixas alteradas são revisáveis. */
function changedScopeMessage(classification: RunClassification): string[] {
	const scope = classification.changedScope;
	if (!scope) return [];
	const totals = summarizeScope(scope);
	return [
		`Escopo: ${totals.files} arquivo(s), ${totals.symbols} símbolo(s) em ${totals.ranges} faixa(s) alterada(s).`,
	];
}

/** Resumo do orçamento — só quando algum arquivo ficou de fora (PR grande). */
function budgetMessage(
	classification: ClassificationResult,
	config: HoundsmanConfig,
): string[] {
	const maxFiles = resolveMaxFilesPerBrief(config);
	let overflow = 0;
	for (const id of Object.keys(classification.watchdogs)) {
		overflow += budgetFor(classification, id, maxFiles, config.priorities ?? [])
			.overflow.length;
	}
	if (overflow === 0) return [];
	return [
		`Orçamento: ${maxFiles} arquivo(s)/brief — ${overflow} fora do orçamento (menor risco; registrar em skipped).`,
	];
}

/** Encaminha o progresso do escopo como etapa do prepare. */
function scopeProgress(onProgress?: PrepareProgress): ScopeProgress | undefined {
	if (!onProgress) return undefined;
	return (event) => emitProgress(onProgress, event);
}

/**
 * Aviso de sobreposição de escopo: o mesmo arquivo casando em vários domínios é
 * revisado uma vez por domínio (recortes diferentes). Explica a cobertura >100%
 * que um watchdog pode declarar e o custo multiplicado em PRs grandes.
 */
export function overlapMessage(
	classification: Pick<ClassificationResult, "watchdogs">,
): string[] {
	const counts = new Map<string, number>();
	for (const files of Object.values(classification.watchdogs)) {
		for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
	}
	const shared = [...counts.values()].filter((count) => count > 1);
	if (shared.length === 0) return [];
	const max = Math.max(...shared);
	return [
		`Escopo: ${shared.length} arquivo(s) em mais de um domínio (máx. ${max}) — cada domínio revisa o arquivo com o seu recorte.`,
	];
}

/** Emite um evento de progresso sem deixar o callback derrubar a revisão. */
function emitProgress(
	onProgress: PrepareProgress | undefined,
	event: PrepareProgressEvent,
): void {
	try {
		onProgress?.(event);
	} catch {
		// Progresso nunca derruba a revisão.
	}
}

/** Executa uma etapa reportando início/fim (sync ou async). */
async function runStage<T>(
	onProgress: PrepareProgress | undefined,
	stage: PrepareStage,
	run: () => Promise<T> | T,
): Promise<T> {
	if (!onProgress) return run();
	const started = Date.now();
	emitProgress(onProgress, { type: "start", stage });
	try {
		return await run();
	} finally {
		emitProgress(onProgress, {
			type: "done",
			stage,
			durationMs: Date.now() - started,
		});
	}
}

/** Como `runStage`, mas só reporta quando a etapa realmente vai rodar. */
async function runOptionalStage<T>(
	onProgress: PrepareProgress | undefined,
	enabled: boolean,
	stage: PrepareStage,
	run: () => Promise<T> | T,
): Promise<T> {
	return enabled ? runStage(onProgress, stage, run) : run();
}

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export class PreparePipeline {
	private readonly artifacts: RunArtifacts;

	constructor(
		private readonly ctx: ReviewContext,
		private readonly config: HoundsmanConfig,
		private readonly opts: ReviewOptions,
		private readonly deps: PrepareDeps = {},
	) {
		this.artifacts = new RunArtifacts(ctx.storage, ctx.review, ctx.work);
	}

	async run(): Promise<PrepareResult> {
		const { ctx, config, opts } = this;
		const { ast, ai, onProgress } = this.deps;
		const branch = ctx.review.branch;
		const messages: string[] = [];
		const startedAt = systemClock();
		const startedMs = Date.now();
		const timings: PrepareStageTiming[] = [];
		// Coleta durações para o `prepare-report.json` sem acoplar o `runStage` ao
		// artefato; etapas concorrentes chegam fora de ordem e são registradas como
		// vieram.
		const timedProgress: PrepareProgress = (event) => {
			if (event.type === "done") {
				timings.push({ stage: event.stage, durationMs: event.durationMs });
			}
			emitProgress(onProgress, event);
		};
		ctx.work.ensure();
		if (opts.clean) ctx.work.cleanFindings();
		ctx.storage.updateReview(ctx.review.id, { base: opts.base, head: opts.head });

		// Marca o commit revisado e decide entre completo, incremental ou no-op.
		const headSha = ctx.git.resolveSha(opts.head);
		const previous = ctx.storage.readFindings(ctx.review.id);
		const scope = await new ReviewScopeResolver(
			opts,
			config,
			opts.noAst ? undefined : ast,
			ctx.git,
			scopeProgress(timedProgress),
		).resolve(previous, headSha);

		// Mesmo commit já revisado: preserva artefatos e triagem, sem re-revisar.
		if (scope.kind === "noop") {
			const status = ctx.storage.getReview(ctx.review.id)?.status ?? null;
			// Ciclo em andamento continua válido (os findings já despachados devem
			// ser finalizados); fora isso, o relatório anterior é a resposta final.
			const pendingCycle = status === "reviewing";
			if (!pendingCycle) {
				writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });
			}
			messages.push(
				`Nenhuma alteração desde a última revisão (${shortSha(scope.reviewedFrom)}).`,
				pendingCycle
					? "Nada novo a preparar — o ciclo em andamento continua; rode `--finalize` quando os findings estiverem gravados."
					: "Nada a revisar — o resumo anterior foi mantido. Use `--full` para re-revisar.",
			);
			return { messages, activeIds: [] };
		}

		const { classification, diff, patch } = scope;

		// Run recém-criada e sem nenhum arquivo alterado: não persiste uma "run
		// vazia" na lista. Acontece quando o comando roda no clone principal sem
		// `--pr`/`--worktree` (ex.: `houndsman` na `main` logo após revisar uma PR).
		// Run com artefatos anteriores (contexto, revisão) continua existindo.
		if (Object.keys(classification.files).length === 0) {
			const fresh = ctx.storage.listArtifacts(ctx.review.id).length === 0;
			if (fresh) {
				ctx.work.clean();
				ctx.storage.deleteReview(ctx.review.id);
				messages.push(
					`Nenhuma alteração entre ${opts.base}...${opts.head} — nenhuma run criada.`,
				);
				return { messages, activeIds: [] };
			}
		}

		// Marca o run como "revisando" (reinicia o ciclo) — a UI mostra o status.
		writeRunStatus(ctx.storage, ctx.review.id, {
			status: "reviewing",
			resetStartedAt: true,
		});

		await this.applyAiClassification(classification);
		// Revisor de lógica obrigatório: recebe todos os arquivos alterados,
		// inclusive os não classificados. Id reservado — não é configurável.
		if (Object.keys(classification.files).length > 0) {
			const files = Object.keys(classification.files).filter(
				(file) => classification.files[file]?.status !== "deleted",
			);
			if (files.length > 0) {
				classification.watchdogs[GENERAL_WATCHDOG_ID] = files;
				classification.stats[GENERAL_WATCHDOG_ID] = files.length;
			}
		}
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "classification.json",
			kind: "classification",
			content: `${JSON.stringify(classification, null, 2)}\n`,
		});

		const astAnalyses = scope.ast;
		const astImpact =
			astAnalyses && ast
				? await runStage(timedProgress, "impact", () => ast.impact(astAnalyses))
				: undefined;
		if (astAnalyses && ast?.enabled) {
			const summary = {
				enabled: true,
				files: Object.fromEntries(
					[...astAnalyses].map(([path, analysis]) => [
						path,
						{
							facts: analysis.facts,
							delta: analysis.delta,
							deleted: analysis.deleted,
						},
					]),
				),
			};
			ctx.storage.writeArtifact(ctx.review.id, {
				name: "ast-summary.json",
				kind: "ast",
				content: `${JSON.stringify(summary, null, 2)}\n`,
			});
			if (astImpact) {
				ctx.storage.writeArtifact(ctx.review.id, {
					name: "ast-impact.json",
					kind: "ast-impact",
					content: `${JSON.stringify(astImpact, null, 2)}\n`,
				});
			}
		}

		const jevWillRun = Boolean(
			(ai && !opts.noAi && new AiPreAnalyzer(ai).enabled) ||
				(!opts.noJev && new JevClient().isConfigured()),
		);

		const activeIds = Object.keys(classification.watchdogs);
		if (Object.keys(classification.files).length === 0) {
			writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });
			messages.push(
				classification.mode === "incremental"
					? `Nenhuma alteração desde a última revisão (${shortSha(classification.reviewedFrom ?? "")}).`
					: `Nenhuma alteração entre ${opts.base}...${opts.head}.`,
			);
			return { messages, activeIds: [] };
		}
		if (activeIds.length === 0) {
			writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });
			messages.push(
				"Nenhum arquivo revisável (tudo excluído, deletado ou irrelevante).",
			);
			return { messages, activeIds: [] };
		}
		if (classification.mode === "incremental") {
			messages.push(
				`Modo incremental: ${Object.keys(classification.files).length} arquivo(s) alterado(s) desde ${shortSha(classification.reviewedFrom ?? "")}; ${classification.carryover?.length ?? 0} finding(s) carregado(s) do review anterior.`,
			);
		}

		this.artifacts.persistContext();
		const aiContext = ai && !opts.noAi ? new AiContextSummarizer(ai).enabled : false;
		// Contexto e pré-análise não dependem um do outro: rodam juntos. Antes, a
		// pré-análise por IA (uma chamada por watchdog) era serial e dominava o
		// prepare em PRs com muitos domínios.
		const [context, jev] = await Promise.all([
			runOptionalStage(timedProgress, aiContext, "context", () =>
				this.resolveContextSummary(),
			),
			runOptionalStage(timedProgress, jevWillRun, "jev", () =>
				this.resolveCandidates(classification, diff),
			),
		]);

		// Intenção da PR — sempre gerada (determinística) e enriquecida pela IA
		// quando disponível. O brief do passo fica no staging para o subagente ou
		// para o pré-passe do `houndsman hunt`.
		const businessDomains = activeIds
			.filter((id) => id !== GENERAL_WATCHDOG_ID)
			.map((id) => ({ id, name: findWatchdog(config, id)?.name ?? id }));
		const businessInput = {
			classification,
			context,
			ast: astAnalyses,
			impact: astImpact,
			changedScope: classification.changedScope,
			headSha: classification.headSha,
			snippets: diff.byFile,
			domains: businessDomains,
		};
		const business = await runStage(timedProgress, "business", () =>
			this.resolveBusinessSummary(businessInput),
		);

		const aiTechnical =
			ai && !opts.noAi ? new AiTechnicalSummarizer(ai).enabled : false;
		const aiBriefs = ai && !opts.noAi ? new AiBriefEnricher(ai).enabled : false;
		// Independentes entre si: hipóteses do `general`, resumo técnico e planos
		// dos briefs. Rodam juntos depois que a intenção está pronta.
		const [, , aiPlans] = await Promise.all([
			this.appendBusinessCandidates(jev, business, businessInput),
			runOptionalStage(timedProgress, aiTechnical, "technical", () =>
				this.resolveTechnicalSummary({
					branch,
					classification,
					context,
					ast: astAnalyses,
					impact: astImpact,
					domains: activeIds.map((id) => findWatchdog(config, id)?.name ?? id),
				}),
			),
			runOptionalStage(timedProgress, aiBriefs, "ai-plans", () =>
				this.buildAiPlans(
					activeIds,
					classification,
					context,
					astAnalyses,
					astImpact,
					business,
					patch,
				),
			),
		]);

		const manifestAst: ManifestAst | undefined = astAnalyses
			? {
					enabled: ast?.enabled ?? false,
					languages: [
						...new Set(
							[...astAnalyses.values()].map(
								(analysis) => analysis.facts.language,
							),
						),
					].sort(),
					files: astAnalyses.size,
					impact: {
						affectedFiles: astImpact?.affectedFiles.length ?? 0,
						importers: Object.keys(astImpact?.importers ?? {}).length,
						exportedChanges: astImpact?.exportedChanges.length ?? 0,
					},
				}
			: undefined;

		if (aiPlans.size > 0) {
			ctx.storage.writeArtifact(ctx.review.id, {
				name: "ai-briefs.json",
				kind: "ai-brief",
				content: `${JSON.stringify(
					{ plans: Object.fromEntries(aiPlans) },
					null,
					2,
				)}\n`,
			});
		}
		const aiUsage = ai?.recorder.total;
		const manifestAi: ManifestAi | undefined =
			ai && !opts.noAi && (aiPlans.size > 0 || (aiUsage?.calls ?? 0) > 0)
				? {
						enabled: true,
						provider: ai.projectConfig.aiProvider,
						model: ai.modelId,
						briefPlans: aiPlans.size,
						usage: aiUsage ?? {
							inputTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
							calls: 0,
						},
					}
				: undefined;

		const briefs = await runStage(timedProgress, "briefs", () =>
			this.writeBriefs(
				activeIds,
				classification,
				branch,
				context,
				jev.candidates,
				astAnalyses,
				astImpact,
				aiPlans,
				business,
				patch,
			),
		);
		const manifestBusiness: ManifestBusiness = {
			source: business.source,
			model: business.source === "ai" ? ai?.modelId : undefined,
			...summarizeBusiness(business),
		};
		await runStage(timedProgress, "manifest", () =>
			this.writeManifest(
				classification,
				activeIds,
				activeIds,
				jev,
				manifestAst,
				manifestAi,
				manifestBusiness,
			),
		);
		messages.push(
			...discoveryMessages(activeIds, classification, ctx.work.briefsDir),
			...budgetMessage(classification, config),
			...changedScopeMessage(classification),
			...overlapMessage(classification),
			...jevSummary(jev),
		);
		if (astAnalyses) {
			messages.push(
				`AST: ${astAnalyses.size} arquivo(s) analisado(s), ` +
					`${astImpact?.affectedFiles.length ?? 0} impactado(s).`,
			);
		} else {
			messages.push("AST: desabilitado ou sem grammar compatível.");
		}

		if (context) {
			messages.push("Contexto da PR resumido e injetado nos briefs.");
		} else {
			messages.push(
				"Sem contexto da PR (rode `bun run houndsman context` antes, se houver PR).",
			);
		}
		const businessSummary = summarizeBusiness(business);
		messages.push(
			business.source === "ai"
				? `Intenção da PR reconstruída pela IA: ${businessSummary.flows} fluxo(s), ${businessSummary.invariants} invariante(s).`
				: `Intenção da PR determinística (${businessSummary.flows} fluxo(s)) — enriquecida no passo de intenção (${displayPath(ctx.work.businessPaths.brief)}).`,
		);
		if (aiPlans.size > 0) {
			messages.push(
				`IA: plano de revisão em ${aiPlans.size} brief(s) (sugestão, não substitui regras).`,
			);
		}
		if (briefs.generalSliced) {
			messages.push(
				`General: recorte por fluxo (${briefs.generalSliced.selected}/${briefs.generalSliced.total} arquivos) — os demais devem ser registrados em \`skipped\`.`,
			);
		}
		if (ai && ((aiUsage?.calls ?? 0) > 0 || ai.recorder.attempts > 0)) {
			const usage = ai.recorder.total;
			const failures = ai.recorder.failures.length;
			messages.push(
				failures > 0
					? `IA: ${usage.calls}/${ai.recorder.attempts} chamada(s) ok, ${usage.totalTokens} token(s), ${failures} falha(s): ${summarizeFailures(ai.recorder.failures)}.`
					: `IA: ${usage.calls} chamada(s), ${usage.totalTokens} token(s).`,
			);
			ai.recorder.write(ctx.storage, ctx.review.id);
		}

		// Duração por etapa (inclui as que rodaram em paralelo) para comparar runs.
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "prepare-report.json",
			kind: "prepare",
			content: renderPrepareReport({
				startedAt,
				durationMs: Date.now() - startedMs,
				stages: timings,
				ai: ai?.recorder.summary,
			}),
		});

		messages.push(
			`\nPróximo passo: despachar os sub-agentes (um por brief em ${displayPath(ctx.work.briefsDir)}/).`,
			"Quando os findings estiverem gravados: bun run houndsman --finalize",
		);

		return {
			messages,
			activeIds,
			briefsDir: ctx.work.briefsDir,
			reviewId: ctx.review.id,
		};
	}

	/**
	 * Schema do output: relativo à raiz da review quando a camada existe; no
	 * worktree sem camada, cai para o asset embarcado (caminho absoluto legível).
	 */
	private outputFormatPathFor(): string {
		if (existsSync(join(this.ctx.root, OUTPUT_FORMAT_PATH)))
			return OUTPUT_FORMAT_PATH;
		return this.ctx.review.worktreePath
			? assetPath(OUTPUT_FORMAT_FILE)
			: OUTPUT_FORMAT_PATH;
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

	private writeBriefs(
		activeIds: string[],
		classification: RunClassification,
		branch: string,
		context: ContextSummary | null,
		candidates: JevCandidate[],
		astAnalyses?: ReadonlyMap<string, AstAnalysis>,
		astImpact?: AstImpact,
		aiPlans?: ReadonlyMap<string, BriefPlan>,
		business?: BusinessSummary,
		patch?: ReadonlyMap<string, string>,
	): { generalSliced?: { selected: number; total: number } } {
		const { ctx, config } = this;
		const work = ctx.work;
		const docs = discoverDocs(Object.keys(classification.files), config);
		const maxFilesPerBrief = resolveMaxFilesPerBrief(config);
		const renderer = new BriefRenderer();
		const summary: { generalSliced?: { selected: number; total: number } } = {};
		for (const id of activeIds) {
			const def = findWatchdog(config, id);
			if (!def) continue;
			const isGeneral = id === GENERAL_WATCHDOG_ID;
			const sliced = isGeneral && shouldSliceGeneral(classification);
			const { selected, overflow } = sliced
				? generalFlowFiles(
						classification,
						business,
						GENERAL_FLOW_MAX_FILES,
						config.priorities,
					)
				: budgetFor(classification, id, maxFilesPerBrief, config.priorities);
			if (sliced) {
				summary.generalSliced = {
					selected: selected.length,
					total: (classification.watchdogs[id] ?? []).length,
				};
			}
			const astFiles: AstFileBrief[] = selected.flatMap((file) => {
				const analysis = astAnalyses?.get(file);
				if (!analysis?.delta) return [];
				return [
					{
						file,
						delta: analysis.delta,
						importers: astImpact?.importers[file],
					},
				];
			});
			// Micro-alterações iguais: 1 representante + outliers em vez de N diffs.
			const propagation = detectPropagation(
				[...selected, ...overflow],
				patch,
				classification.churn,
			);
			// Contratos alterados com importadores fora do diff (possível lacuna).
			const propagationGaps = detectPropagationGaps(
				selected,
				astAnalyses,
				astImpact,
				new Set(Object.keys(classification.files)),
			);
			const brief = renderer.render(new Watchdog(def), {
				watchdogId: id,
				files: selected,
				statuses: classification.files,
				churn: classification.churn,
				overflow,
				deleted: classification.deleted,
				branch,
				outputPath: work.findingFile(id),
				outputFormatPath: this.outputFormatPathFor(),
				worktree: ctx.review.worktreePath,
				docs,
				context,
				candidates: candidates.filter((c) => c.watchdogId === id),
				ast: astFiles,
				aiPlan: aiPlans?.get(id),
				business,
				businessSummaryPath: business ? work.businessPaths.summary : undefined,
				propagation,
				propagationGaps,
				// Todos os watchdogs recebem o diff: sem ele o subagente relê o arquivo
				// inteiro só para enxergar as linhas alteradas. O `general` vê mais.
				snippets: buildBriefSnippets(
					selected,
					patch,
					isGeneral
						? {
								total: GENERAL_BRIEF_SNIPPET_CHARS,
								perFile: sliced
									? GENERAL_FLOW_SNIPPET_CHARS_PER_FILE
									: GENERAL_BRIEF_SNIPPET_CHARS_PER_FILE,
							}
						: undefined,
				),
				changedScope: classification.changedScope,
			});
			const content = `${brief}\n`;
			work.writeBrief(id, content);
			// Auditoria: o brief também fica no storage (o staging é limpo no finalize).
			ctx.storage.writeArtifact(ctx.review.id, {
				name: `briefs/${id}.md`,
				kind: "brief",
				content,
			});
		}
		return summary;
	}

	/**
	 * Resolve os candidatos Jev (Passo 1.5). Sempre grava `candidates.json`.
	 * Falha-aberto: sem chave / erro / `--no-jev` → artefato `available:false`.
	 */
	private async resolveCandidates(
		classification: ClassificationResult,
		diff: DiffSource,
	): Promise<JevCandidatesFile> {
		const { ctx, config, opts } = this;
		const ai = this.deps.ai;
		const save = (data: JevCandidatesFile): JevCandidatesFile => {
			ctx.storage.writeArtifact(ctx.review.id, {
				name: "candidates.json",
				kind: "candidates",
				content: serializeCandidates(data),
			});
			return data;
		};

		// Pré-análise por IA (opcional) tem precedência sobre o Jev.
		if (ai && !opts.noAi) {
			const analyzer = new AiPreAnalyzer(ai);
			if (analyzer.enabled) {
				// Uma chamada por watchdog, concorrência limitada (antes era serial e
				// dominava o prepare em PRs com muitos domínios).
				const entries = Object.entries(classification.watchdogs).filter(
					([id]) => id !== GENERAL_WATCHDOG_ID,
				);
				const perWatchdog = await mapPool(
					entries,
					ai.projectConfig.aiConcurrency,
					async ([id, files]) => {
						const def = findWatchdog(config, id);
						if (!def) return [];
						const inputs = files.slice(0, 5).flatMap((file) => {
							// Só o trecho alterado: candidato fora do diff vira ruído de código
							// pré-existente no brief do watchdog.
							const snippet = diff.byFile.get(file);
							return snippet ? [{ file, snippet }] : [];
						});
						return analyzer.analyze({
							watchdogId: id,
							name: def.name,
							rules: def.rules,
							files: inputs,
						});
					},
				);
				return save({
					available: true,
					model: ai.modelId,
					threshold: JevCandidatesStore.THRESHOLD,
					analyzedFiles: Object.values(classification.watchdogs).flat().length,
					candidates: perWatchdog.flat(),
				});
			}
		}

		if (opts.noJev) {
			return save(JevCandidatesStore.unavailable("desativado (--no-jev)"));
		}

		const client = new JevClient();
		if (!client.isConfigured()) {
			return save(
				JevCandidatesStore.unavailable(
					`${ENV_NAMES.typeSafeApiKey} não configurada`,
				),
			);
		}

		try {
			const detector = new JevDetector(
				client,
				config.watchdogs as Record<string, WatchdogMeta>,
				ctx.root,
			);
			const result = await detector.detect(classification, opts.base, opts.head, {
				diff,
				concurrency: resolveJevConcurrency(config),
			});
			return save({
				available: true,
				model: result.model,
				threshold: JevCandidatesStore.THRESHOLD,
				analyzedFiles: result.analyzedFiles,
				candidates: result.candidates,
				skipped: result.skipped.length > 0 ? result.skipped : undefined,
			});
		} catch (error) {
			return save(
				JevCandidatesStore.unavailable(
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	}

	/**
	 * Classificação fallback por IA (opcional): atribui arquivos não classificados
	 * a watchdogs conhecidos. Fail-open — falha mantém `unclassified`.
	 */
	private async applyAiClassification(
		classification: RunClassification,
	): Promise<void> {
		const { config, opts } = this;
		const ai = this.deps.ai;
		if (!ai || opts.noAi || classification.unclassified.length === 0) return;
		const classifier = new AiClassifier(ai);
		if (!classifier.enabled) return;
		const watchdogs = config.watchdogIds.flatMap((id) => {
			const def = config.watchdogs[id];
			return def ? [{ id, name: def.name, scope: def.scope }] : [];
		});
		const assignments = await classifier.classify(
			classification.unclassified,
			watchdogs,
		);
		if (assignments.size === 0) return;
		for (const [file, id] of assignments) {
			const list = classification.watchdogs[id] ?? [];
			if (!list.includes(file)) list.push(file);
			classification.watchdogs[id] = list;
			classification.stats[id] = list.length;
		}
		classification.unclassified = classification.unclassified.filter(
			(file) => !assignments.has(file),
		);
	}

	/**
	 * Resumo do contexto da PR: usa o do subagente ou, na ausência, a IA
	 * (`AiContextSummarizer`). Grava o artefato e o staging.
	 */
	private async resolveContextSummary(): Promise<ContextSummary | null> {
		const { ctx, opts } = this;
		const ai = this.deps.ai;
		const existing = ctx.work.readContextSummary() ?? this.artifacts.contextSummary();
		if (existing) return existing;
		if (!ai || opts.noAi) return null;
		const raw = ctx.work.readContextRaw();
		if (!raw) return null;
		const summary = await new AiContextSummarizer(ai).summarize(raw);
		if (!summary) return null;
		ctx.work.writeContextSummary(summary);
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "context-summary.json",
			kind: "context-summary",
			content: `${JSON.stringify(summary, null, 2)}\n`,
		});
		return summary;
	}

	/**
	 * Pontos técnicos estruturais: IA quando disponível e, sempre, um fallback
	 * determinístico a partir da classificação/AST. Persistido para auditoria —
	 * o `finalize` apenas o consome.
	 */
	private async resolveTechnicalSummary(input: {
		branch: string;
		classification: RunClassification;
		context: ContextSummary | null;
		ast?: ReadonlyMap<string, AstAnalysis>;
		impact?: AstImpact;
		domains: readonly string[];
	}): Promise<TechnicalSummary> {
		const { ctx, opts } = this;
		const ai = this.deps.ai;
		const fallback = buildTechnicalSummary({
			classification: input.classification,
			ast: input.ast,
			impact: input.impact,
			headSha: input.classification.headSha,
		});
		const summary =
			ai && !opts.noAi
				? ((await new AiTechnicalSummarizer(ai).summarize({
						branch: input.branch,
						context: input.context,
						classification: input.classification,
						ast: input.ast,
						impact: input.impact,
						headSha: input.classification.headSha,
						domains: input.domains,
					})) ?? fallback)
				: fallback;
		ctx.storage.writeArtifact(ctx.review.id, {
			name: TECHNICAL_SUMMARY_FILE,
			kind: "technical",
			content: `${JSON.stringify(summary, null, 2)}\n`,
		});
		return summary;
	}

	/**
	 * Modelo de intenção (Passo 1.4): determinístico sempre, IA quando disponível.
	 * O brief do passo fica no staging para a skill (subagente) ou o `hunt` (maki).
	 */
	private async resolveBusinessSummary(input: BusinessInput): Promise<BusinessSummary> {
		const { ctx, config, opts } = this;
		const ai = this.deps.ai;
		const fallback = buildBusinessSummary(input);
		const summary =
			ai && !opts.noAi
				? ((await new AiBusinessSummarizer(ai).summarize(input)) ?? fallback)
				: fallback;

		ctx.work.writeBusinessSummary(summary);
		ctx.storage.writeArtifact(ctx.review.id, {
			name: BUSINESS_SUMMARY_FILE,
			kind: "business",
			content: `${JSON.stringify(summary, null, 2)}\n`,
		});

		const files = Object.entries(input.classification.files)
			.map(([path, file]) => {
				const analysis = input.ast?.get(path);
				const symbols = analysis?.delta
					? [
							...analysis.delta.addedSymbols,
							...analysis.delta.modifiedSymbols,
						].map((symbol) => symbol.name)
					: [];
				return {
					path,
					status: file.status,
					ranges: input.changedScope?.[path]?.ranges,
					symbols: [...new Set(symbols)].slice(0, 8),
				};
			})
			.sort(
				(a, b) =>
					(input.classification.churn[b.path]?.additions ?? 0) +
					(input.classification.churn[b.path]?.deletions ?? 0) -
					((input.classification.churn[a.path]?.additions ?? 0) +
						(input.classification.churn[a.path]?.deletions ?? 0)),
			);

		const docs = discoverDocs(Object.keys(input.classification.files), config);
		const brief = buildBusinessBrief({
			projectName: config.projectName,
			branch: ctx.review.branch,
			headSha: input.headSha,
			outputPath: ctx.work.businessPaths.summary,
			business: summary,
			files,
			docs,
			context: input.context,
		});
		ctx.work.writeBusinessBrief(brief.trimEnd());
		ctx.storage.writeArtifact(ctx.review.id, {
			name: BUSINESS_BRIEF_FILE,
			kind: "business-brief",
			content: `${brief.trimEnd()}\n`,
		});

		return summary;
	}

	/**
	 * Hipóteses de lógica/domínio (opt-in por IA) — candidatos que o revisor
	 * `general` confirma ou refuta. Nunca viram achado sozinhos.
	 */
	private async appendBusinessCandidates(
		jev: JevCandidatesFile,
		business: BusinessSummary,
		input: BusinessInput,
	): Promise<void> {
		const { ctx, opts } = this;
		const ai = this.deps.ai;
		if (!ai || opts.noAi) return;
		const analyzer = new AiBusinessAnalyzer(ai);
		if (!analyzer.enabled) return;
		const candidates = await analyzer.analyze({ business, payload: input });
		if (candidates.length === 0) return;
		jev.candidates.push(...candidates);
		jev.available = true;
		jev.model = jev.model ?? ai.modelId;
		jev.reason = undefined;
		jev.analyzedFiles = Math.max(
			jev.analyzedFiles ?? 0,
			Object.keys(input.classification.files).length,
		);
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "candidates.json",
			kind: "candidates",
			content: serializeCandidates(jev),
		});
	}

	/**
	 * Planos de revisão por watchdog (uma chamada por brief, concorrência
	 * limitada). Sem IA/chave/feature, devolve mapa vazio e o brief fica igual.
	 */
	private async buildAiPlans(
		activeIds: string[],
		classification: ClassificationResult,
		context: ContextSummary | null,
		astAnalyses: ReadonlyMap<string, AstAnalysis> | undefined,
		astImpact: AstImpact | undefined,
		business?: BusinessSummary,
		patch?: ReadonlyMap<string, string>,
	): Promise<Map<string, BriefPlan>> {
		const { config, opts } = this;
		const ai = this.deps.ai;
		const plans = new Map<string, BriefPlan>();
		if (!ai || opts.noAi) return plans;
		const enricher = new AiBriefEnricher(ai);
		if (!enricher.enabled) return plans;

		const docs = discoverDocs(Object.keys(classification.files), config);
		const maxFilesPerBrief = resolveMaxFilesPerBrief(config);
		const inputs = [];
		for (const id of activeIds) {
			const def = findWatchdog(config, id);
			if (!def) continue;
			const { selected } = budgetFor(
				classification,
				id,
				maxFilesPerBrief,
				config.priorities,
			);
			const astFiles: AstFileBrief[] = selected.flatMap((file) => {
				const analysis = astAnalyses?.get(file);
				if (!analysis?.delta) return [];
				return [
					{
						file,
						delta: analysis.delta,
						importers: astImpact?.importers[file],
					},
				];
			});
			inputs.push({
				watchdogId: id,
				name: def.name,
				description: def.description,
				scope: def.scope,
				rules: def.rules,
				files: selected,
				churn: classification.churn,
				context,
				ast: astFiles,
				docs,
				business,
				snippets: buildBriefSnippets(selected, patch),
			});
		}
		return enricher.enrichAll(inputs);
	}
}
