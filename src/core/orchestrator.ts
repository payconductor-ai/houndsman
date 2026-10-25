/**
 * Orquestração do houndsman (biblioteca): preparar (classificação + briefs +
 * manifesto + Jev) e finalizar (findings → dedupe → relatório).
 *
 * Genérico: recebe o `HoundsmanConfig` por parâmetro (injeção explícita).
 * Entrypoints: `cli/index.ts` (`houndsman`). Aqui não há `process.argv`.
 *
 * Persistência:
 *   storage               reviews/findings/artefatos (SQLite por default)
 *   <home>/work/<review>  staging dos subagentes
 *     briefs/<id>.md      instruções prontas para cada sub-agente
 *     findings/<id>.json  saída dos sub-agentes (schema skill/OUTPUT-FORMAT.md)
 *     context*.json/md    contexto da PR (Passo 0)
 *
 * Artefatos persistidos: classification, candidates, manifest, review.md,
 * review.<watchdog>.md, context e context-summary.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AiClient } from "./ai/ai-client";
import { AiBriefEnricher } from "./ai/features/brief-enricher";
import { AiBusinessAnalyzer } from "./ai/features/business-analyzer";
import { AiBusinessSummarizer } from "./ai/features/business-summarizer";
import { AiClassifier } from "./ai/features/classifier";
import { AiContextSummarizer } from "./ai/features/context-summarizer";
import { AiPreAnalyzer } from "./ai/features/pre-analyzer";
import { AiTechnicalSummarizer } from "./ai/features/technical-summarizer";
import type { BriefPlan } from "./ai/schemas";
import { assetPath, OUTPUT_FORMAT_FILE } from "./assets";
import type { AstService } from "./ast/service";
import type { AstAnalysis, AstFileBrief, AstImpact } from "./ast/types";
import { GENERAL_WATCHDOG_ID } from "./builtins";
import {
	type BusinessInput,
	type BusinessSummary,
	buildBusinessBrief,
	buildBusinessSummary,
	parseBusinessSummary,
	summarizeBusiness,
} from "./business-summary";
import { summarizeScope } from "./changed-scope";
import {
	type HoundsmanConfig,
	resolveJevConcurrency,
	resolveMaxFilesPerBrief,
} from "./config";
import type { DiffSource } from "./diff-source";
import { discoverDocs } from "./doc-discoverer";
import { Classification } from "./domain/classification";
import { Watchdog } from "./domain/watchdog";
import { mergeCarryover } from "./engine/carryover";
import {
	ReviewScopeResolver,
	type RunClassification,
	type ScopeProgress,
} from "./engine/review-scope";
import { ENV_NAMES } from "./env";
import type { BudgetSelection, ClassificationResult } from "./file-classifier";
import { buildStateFromFindings, fileReader } from "./findings-state";
import { syncResolvedThreads } from "./github-review";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
	parseCandidates,
	serializeCandidates,
} from "./jev";
import {
	BUSINESS_BRIEF_FILE,
	BUSINESS_SUMMARY_FILE,
	displayPath,
	OUTPUT_FORMAT_PATH,
	REVIEW_FILE,
	REVIEW_RESUME_FILE,
	TECHNICAL_SUMMARY_FILE,
} from "./paths";
import { ProjectConfig } from "./project-config";
import { BriefRenderer } from "./renderers/brief-renderer";
import {
	type ManifestAi,
	type ManifestAst,
	type ManifestBusiness,
	ManifestWriter,
} from "./renderers/manifest-writer";
import { ReportRenderer } from "./renderers/report-renderer";
import { renderReviewResume } from "./renderers/resume-renderer";
import {
	type ContextSummary,
	type DomainReport,
	dedupeFindings,
	parseContextSummary,
	sanitizeBranch,
	type WatchdogReport,
} from "./report-builder";
import { writeRunStatus } from "./run-status";
import { systemClock } from "./services/clock";
import { GitRepository } from "./services/git-repository";
import type { ReviewRecord, StorageProvider } from "./storage/types";
import { ReviewWorkArea } from "./storage/work-area";
import {
	buildTechnicalSummary,
	parseTechnicalSummary,
	type TechnicalSummary,
} from "./technical-summary";
import type { WatchdogMeta } from "./types";
import { findWatchdog } from "./watchdog-registry";

export type ReviewOptions = {
	base: string;
	head: string;
	branch?: string;
	finalize: boolean;
	failOnBlocking: boolean;
	clean: boolean;
	noJev: boolean;
	/** Desativa a análise estrutural (AST) nesta run. */
	noAst: boolean;
	/** Força review completo (ignora o modo incremental). */
	full: boolean;
	/** Desativa as features de IA do fluxo normal. */
	noAi: boolean;
	/** PR de origem (resolvida via `--pr`). */
	pr?: number;
	/** Worktree informado via flag (`--worktree`). */
	worktree?: string;
	/** Worktree resolvido (absoluto; ausente = clone principal). */
	worktreePath?: string;
};

/** Valores default das opções (o CLI sobrepõe com as flags). */
export function defaultOptions(): ReviewOptions {
	return {
		base: "main",
		head: "HEAD",
		finalize: false,
		failOnBlocking: false,
		clean: false,
		noJev: false,
		noAst: false,
		full: false,
		noAi: false,
	};
}

/** Workspace onde os arquivos da review são lidos. */
export type ReviewWorkspaceContext = {
	/** Raiz operacional (worktree ou clone principal). */
	root?: string;
	/** Raiz do clone principal (identidade/config). */
	mainRoot?: string;
	git?: GitRepository;
};

/** Contexto de uma run: storage + review + staging + raiz operacional. */
export type ReviewContext = {
	storage: StorageProvider;
	review: ReviewRecord;
	work: ReviewWorkArea;
	root: string;
	mainRoot: string;
	git: GitRepository;
};

/** Cria o contexto de uma review existente. */
export function reviewContext(
	storage: StorageProvider,
	review: ReviewRecord,
	workspace: ReviewWorkspaceContext = {},
): ReviewContext {
	const root = workspace.root ?? process.cwd();
	return {
		storage,
		review,
		work: new ReviewWorkArea(review),
		root,
		mainRoot: workspace.mainRoot ?? root,
		git: workspace.git ?? new GitRepository(),
	};
}

/**
 * Schema do output: relativo à raiz da review quando a camada existe; no
 * worktree sem camada, cai para o asset embarcado (caminho absoluto legível).
 */
function outputFormatPathFor(ctx: ReviewContext): string {
	if (existsSync(join(ctx.root, OUTPUT_FORMAT_PATH))) return OUTPUT_FORMAT_PATH;
	return ctx.review.worktreePath ? assetPath(OUTPUT_FORMAT_FILE) : OUTPUT_FORMAT_PATH;
}

// ---------------------------------------------------------------------------
// Escopo da revisão (completo vs incremental)
// ---------------------------------------------------------------------------

/** SHA curto para logs (7 chars, como o git). */
function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

/** Aviso no topo do `review.md` quando a revisão foi incremental (senão vazio). */
function incrementalNote(classification: RunClassification): string {
	if (classification.mode !== "incremental" || !classification.reviewedFrom) return "";
	const carried = classification.carryover?.length ?? 0;
	return (
		`> **Revisão incremental** — desde \`${shortSha(classification.reviewedFrom)}\`; ` +
		`${Object.keys(classification.files).length} arquivo(s) alterado(s), ` +
		`${carried} finding(s) carregado(s) do review anterior.\n\n`
	);
}

// ---------------------------------------------------------------------------
// Orçamento (triage de PRs grandes)
// ---------------------------------------------------------------------------

/** Aplica o orçamento aos arquivos de um watchdog. */
function budgetFor(
	classification: ClassificationResult,
	id: string,
	maxFiles: number,
): BudgetSelection {
	return Classification.from(classification).budgetFor(id, maxFiles);
}

/** Grava o manifesto da run (delegado ao `ManifestWriter`). */
function writeManifest(
	ctx: ReviewContext,
	config: HoundsmanConfig,
	opts: ReviewOptions,
	classification: RunClassification,
	activeIds: string[],
	pending: string[],
	jev: JevCandidatesFile,
	ast?: ManifestAst,
	ai?: ManifestAi,
	business?: ManifestBusiness,
): void {
	new ManifestWriter(
		ctx.storage,
		ctx.review,
		ctx.work,
		new ProjectConfig(config),
		opts,
	).write(classification, activeIds, pending, jev, ast, ai, business);
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/**
 * Trechos do diff para o revisor de fluxo: cap por arquivo e cap total (o
 * subagente lê o restante do arquivo; aqui só entra o que mudou).
 */
function buildSnippets(
	files: readonly string[],
	diff: DiffSource | undefined,
	maxTotal = 24_000,
	maxPerFile = 2_500,
): { file: string; snippet: string }[] {
	if (!diff) return [];
	const snippets: { file: string; snippet: string }[] = [];
	let used = 0;
	for (const file of files) {
		const patch = diff.byFile.get(file);
		if (!patch) continue;
		const remaining = maxTotal - used;
		if (remaining <= 0) break;
		const snippet = patch.slice(0, Math.min(maxPerFile, remaining));
		used += snippet.length;
		snippets.push({ file, snippet });
	}
	return snippets;
}

function writeBriefs(
	activeIds: string[],
	classification: RunClassification,
	ctx: ReviewContext,
	branch: string,
	context: ContextSummary | null,
	candidates: JevCandidate[],
	config: HoundsmanConfig,
	astAnalyses?: ReadonlyMap<string, AstAnalysis>,
	astImpact?: AstImpact,
	aiPlans?: ReadonlyMap<string, BriefPlan>,
	business?: BusinessSummary,
	diff?: DiffSource,
): void {
	const work = ctx.work;
	const docs = discoverDocs(Object.keys(classification.files), config);
	const maxFilesPerBrief = resolveMaxFilesPerBrief(config);
	const renderer = new BriefRenderer();
	for (const id of activeIds) {
		const def = findWatchdog(config, id);
		if (!def) continue;
		const { selected, overflow } = budgetFor(classification, id, maxFilesPerBrief);
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
		const brief = renderer.render(new Watchdog(def), {
			watchdogId: id,
			files: selected,
			statuses: classification.files,
			churn: classification.churn,
			overflow,
			deleted: classification.deleted,
			branch,
			outputPath: work.findingFile(id),
			outputFormatPath: outputFormatPathFor(ctx),
			worktree: ctx.review.worktreePath,
			docs,
			context,
			candidates: candidates.filter((c) => c.watchdogId === id),
			ast: astFiles,
			aiPlan: aiPlans?.get(id),
			business,
			businessSummaryPath: business ? work.businessPaths.summary : undefined,
			snippets:
				id === GENERAL_WATCHDOG_ID ? buildSnippets(selected, diff) : undefined,
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
}

// ---------------------------------------------------------------------------
// Passo 1 — preparar
// ---------------------------------------------------------------------------

/**
 * Resolve os candidatos Jev (Passo 1.5). Sempre grava `candidates.json`.
 * Falha-aberto: sem chave / erro / `--no-jev` → artefato `available:false`.
 */
async function resolveCandidates(
	opts: ReviewOptions,
	classification: ClassificationResult,
	ctx: ReviewContext,
	config: HoundsmanConfig,
	diff: DiffSource,
	ai?: AiClient,
): Promise<JevCandidatesFile> {
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
			const candidates: JevCandidate[] = [];
			for (const [id, files] of Object.entries(classification.watchdogs)) {
				// O `general` recebe hipóteses próprias (`AiBusinessAnalyzer`), não
				// candidatos por regra.
				if (id === GENERAL_WATCHDOG_ID) continue;
				const def = findWatchdog(config, id);
				if (!def) continue;
				const inputs = files.slice(0, 5).flatMap((file) => {
					// Só o trecho alterado: candidato fora do diff vira ruído de código
					// pré-existente no brief do watchdog.
					const snippet = diff.byFile.get(file);
					return snippet ? [{ file, snippet }] : [];
				});
				candidates.push(
					...(await analyzer.analyze({
						watchdogId: id,
						name: def.name,
						rules: def.rules,
						files: inputs,
					})),
				);
			}
			return save({
				available: true,
				model: ai.modelId,
				threshold: JevCandidatesStore.THRESHOLD,
				analyzedFiles: Object.values(classification.watchdogs).flat().length,
				candidates,
			});
		}
	}

	if (opts.noJev) {
		return save(JevCandidatesStore.unavailable("desativado (--no-jev)"));
	}

	const client = new JevClient();
	if (!client.isConfigured()) {
		return save(
			JevCandidatesStore.unavailable(`${ENV_NAMES.typeSafeApiKey} não configurada`),
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

function jevSummary(jev: JevCandidatesFile): string[] {
	if (!jev.available) return [`Jev: pulado (${jev.reason}).`];
	const skipped = jev.skipped?.length ?? 0;
	return [
		`Jev: ${jev.candidates.length} candidato(s) em ${jev.analyzedFiles ?? 0} arquivo(s)` +
			(skipped > 0 ? `, ${skipped} com falha.` : "."),
	];
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
		overflow += budgetFor(classification, id, maxFiles).overflow.length;
	}
	if (overflow === 0) return [];
	return [
		`Orçamento: ${maxFiles} arquivo(s)/brief — ${overflow} fora do orçamento (menor churn; registrar em skipped).`,
	];
}

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

/** Encaminha o progresso do escopo como etapa do prepare. */
function scopeProgress(onProgress?: PrepareProgress): ScopeProgress | undefined {
	if (!onProgress) return undefined;
	return (event) => emitProgress(onProgress, event);
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

/**
 * Classificação fallback por IA (opcional): atribui arquivos não classificados
 * a watchdogs conhecidos. Fail-open — falha mantém `unclassified`.
 */
async function applyAiClassification(
	classification: RunClassification,
	config: HoundsmanConfig,
	ai: AiClient | undefined,
	opts: ReviewOptions,
): Promise<void> {
	if (!ai || opts.noAi || classification.unclassified.length === 0) return;
	const classifier = new AiClassifier(ai);
	if (!classifier.enabled) return;
	const watchdogs = config.watchdogIds.flatMap((id) => {
		const def = config.watchdogs[id];
		return def ? [{ id, name: def.name, scope: def.scope }] : [];
	});
	const assignments = await classifier.classify(classification.unclassified, watchdogs);
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
async function resolveContextSummary(
	ctx: ReviewContext,
	ai: AiClient | undefined,
	opts: ReviewOptions,
): Promise<ContextSummary | null> {
	const existing = ctx.work.readContextSummary() ?? readPersistedContextSummary(ctx);
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
async function resolveTechnicalSummary(
	ctx: ReviewContext,
	ai: AiClient | undefined,
	opts: ReviewOptions,
	input: {
		branch: string;
		classification: RunClassification;
		context: ContextSummary | null;
		ast?: ReadonlyMap<string, AstAnalysis>;
		impact?: AstImpact;
		domains: readonly string[];
	},
): Promise<TechnicalSummary> {
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
async function resolveBusinessSummary(
	ctx: ReviewContext,
	ai: AiClient | undefined,
	opts: ReviewOptions,
	config: HoundsmanConfig,
	input: BusinessInput,
): Promise<BusinessSummary> {
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
				? [...analysis.delta.addedSymbols, ...analysis.delta.modifiedSymbols].map(
						(symbol) => symbol.name,
					)
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
async function appendBusinessCandidates(
	ctx: ReviewContext,
	ai: AiClient | undefined,
	opts: ReviewOptions,
	jev: JevCandidatesFile,
	business: BusinessSummary,
	input: BusinessInput,
): Promise<void> {
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
async function buildAiPlans(
	activeIds: string[],
	classification: ClassificationResult,
	config: HoundsmanConfig,
	context: ContextSummary | null,
	astAnalyses: ReadonlyMap<string, AstAnalysis> | undefined,
	astImpact: AstImpact | undefined,
	ai: AiClient | undefined,
	opts: ReviewOptions,
	business?: BusinessSummary,
	diff?: DiffSource,
): Promise<Map<string, BriefPlan>> {
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
		const { selected } = budgetFor(classification, id, maxFilesPerBrief);
		const astFiles: AstFileBrief[] = selected.flatMap((file) => {
			const analysis = astAnalyses?.get(file);
			if (!analysis?.delta) return [];
			return [
				{ file, delta: analysis.delta, importers: astImpact?.importers[file] },
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
			snippets: buildSnippets(selected, diff),
		});
	}
	return enricher.enrichAll(inputs);
}

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export async function prepare(
	opts: ReviewOptions,
	branch: string,
	config: HoundsmanConfig,
	ctx: ReviewContext,
	ast?: AstService,
	ai?: AiClient,
	onProgress?: PrepareProgress,
): Promise<PrepareResult> {
	const messages: string[] = [];
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
		scopeProgress(onProgress),
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
				: "Nada a revisar — o relatório anterior foi mantido. Use `--full` para re-revisar.",
		);
		return { messages, activeIds: [] };
	}

	const { classification, diff } = scope;

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

	await applyAiClassification(classification, config, ai, opts);
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
			? await runStage(onProgress, "impact", () => ast.impact(astAnalyses))
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
	const jev = await runOptionalStage(onProgress, jevWillRun, "jev", () =>
		resolveCandidates(opts, classification, ctx, config, diff, ai),
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

	persistContext(ctx);
	const aiContext = ai && !opts.noAi ? new AiContextSummarizer(ai).enabled : false;
	const context = await runOptionalStage(onProgress, aiContext, "context", () =>
		resolveContextSummary(ctx, ai, opts),
	);

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
	const business = await runStage(onProgress, "business", () =>
		resolveBusinessSummary(ctx, ai, opts, config, businessInput),
	);
	await appendBusinessCandidates(ctx, ai, opts, jev, business, businessInput);

	const aiTechnical = ai && !opts.noAi ? new AiTechnicalSummarizer(ai).enabled : false;
	await runOptionalStage(onProgress, aiTechnical, "technical", () =>
		resolveTechnicalSummary(ctx, ai, opts, {
			branch,
			classification,
			context,
			ast: astAnalyses,
			impact: astImpact,
			domains: activeIds.map((id) => findWatchdog(config, id)?.name ?? id),
		}),
	);

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

	const aiBriefs = ai && !opts.noAi ? new AiBriefEnricher(ai).enabled : false;
	const aiPlans = await runOptionalStage(onProgress, aiBriefs, "ai-plans", () =>
		buildAiPlans(
			activeIds,
			classification,
			config,
			context,
			astAnalyses,
			astImpact,
			ai,
			opts,
			business,
			diff,
		),
	);
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

	await runStage(onProgress, "briefs", () =>
		writeBriefs(
			activeIds,
			classification,
			ctx,
			branch,
			context,
			jev.candidates,
			config,
			astAnalyses,
			astImpact,
			aiPlans,
			business,
			diff,
		),
	);
	const manifestBusiness: ManifestBusiness = {
		source: business.source,
		model: business.source === "ai" ? ai?.modelId : undefined,
		...summarizeBusiness(business),
	};
	await runStage(onProgress, "manifest", () =>
		writeManifest(
			ctx,
			config,
			opts,
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
	if (aiUsage && aiUsage.calls > 0) {
		messages.push(
			`IA: ${aiUsage.calls} chamada(s), ${aiUsage.totalTokens} token(s).`,
		);
		ai?.recorder.write(ctx.storage, ctx.review.id);
	}

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
/** Persiste o contexto da PR (bruto + resumo) como artefatos, quando existirem. */
function persistContext(ctx: ReviewContext): void {
	const raw = ctx.work.readContextRaw();
	if (raw !== null) {
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "context.json",
			kind: "context",
			content: raw,
		});
	}
	const summary = ctx.work.readContextSummaryRaw();
	if (summary !== null) {
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "context-summary.json",
			kind: "context-summary",
			content: summary,
		});
	}
	const brief = ctx.work.readContextBriefRaw();
	if (brief !== null) {
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "context-brief.md",
			kind: "context-brief",
			content: brief,
		});
	}
}

// ---------------------------------------------------------------------------
// Passo 2 — finalizar
// ---------------------------------------------------------------------------

/** Reaproveita `ast`/`ai`/`business` do manifesto anterior (o finalize não os recalcula). */
function readManifestExtras(ctx: ReviewContext): {
	ast?: ManifestAst;
	ai?: ManifestAi;
	business?: ManifestBusiness;
} {
	const artifact = ctx.storage.readArtifact(ctx.review.id, "manifest.json");
	if (!artifact) return {};
	try {
		const parsed = JSON.parse(artifact.content) as {
			ast?: ManifestAst;
			ai?: ManifestAi;
			business?: ManifestBusiness;
		};
		return { ast: parsed.ast, ai: parsed.ai, business: parsed.business ?? undefined };
	} catch {
		return {};
	}
}

/** Lê o `classification.json` persistido pelo prepare (lança se ausente). */
function readClassification(ctx: ReviewContext): RunClassification {
	const artifact = ctx.storage.readArtifact(ctx.review.id, "classification.json");
	if (!artifact) {
		throw new Error(
			`Não encontrei a classificação da review. Rode \`bun run houndsman\` (preparar) primeiro.`,
		);
	}
	return JSON.parse(artifact.content) as RunClassification;
}

/** Lê os candidatos Jev persistidos (unavailable se ausente/inválido). */
function readCandidates(ctx: ReviewContext, config: HoundsmanConfig): JevCandidatesFile {
	const artifact = ctx.storage.readArtifact(ctx.review.id, "candidates.json");
	if (!artifact) return JevCandidatesStore.unavailable("candidates.json ausente");
	try {
		return (
			parseCandidates(JSON.parse(artifact.content), [
				...config.watchdogIds,
				GENERAL_WATCHDOG_ID,
			]) ?? JevCandidatesStore.unavailable("candidates.json inválido")
		);
	} catch {
		return JevCandidatesStore.unavailable("candidates.json inválido");
	}
}

/** Resumo do contexto persistido (usado quando o staging já foi limpo). */
function readPersistedContextSummary(ctx: ReviewContext): ContextSummary | null {
	const artifact = ctx.storage.readArtifact(ctx.review.id, "context-summary.json");
	if (!artifact) return null;
	try {
		return parseContextSummary(JSON.parse(artifact.content));
	} catch {
		return null;
	}
}

/** JSON persistido, ou `null` quando ausente/inválido. */
function readArtifactJson<T>(ctx: ReviewContext, name: string): T | null {
	const artifact = ctx.storage.readArtifact(ctx.review.id, name);
	if (!artifact) return null;
	try {
		return JSON.parse(artifact.content) as T;
	} catch {
		return null;
	}
}

/** Modelo de intenção persistido pelo prepare/revisor; `null` quando ausente. */
function readPersistedBusinessSummary(ctx: ReviewContext): BusinessSummary | null {
	const raw = readArtifactJson<unknown>(ctx, BUSINESS_SUMMARY_FILE);
	return raw ? parseBusinessSummary(raw) : null;
}

/**
 * Persiste o `business-summary.json` final: o revisor `general` pode ter
 * reescrito o modelo no staging durante a revisão.
 */
function persistBusiness(ctx: ReviewContext): BusinessSummary | null {
	const raw = ctx.work.readBusinessSummaryRaw();
	if (raw === null) return readPersistedBusinessSummary(ctx);
	ctx.storage.writeArtifact(ctx.review.id, {
		name: BUSINESS_SUMMARY_FILE,
		kind: "business",
		content: raw.endsWith("\n") ? raw : `${raw}\n`,
	});
	const brief = ctx.work.readBusinessBriefRaw();
	if (brief !== null) {
		ctx.storage.writeArtifact(ctx.review.id, {
			name: BUSINESS_BRIEF_FILE,
			kind: "business-brief",
			content: brief.endsWith("\n") ? brief : `${brief}\n`,
		});
	}
	try {
		return parseBusinessSummary(JSON.parse(raw), "reviewer");
	} catch {
		return readPersistedBusinessSummary(ctx);
	}
}

/** Pontos técnicos persistidos pelo `prepare`; `null` quando ausentes. */
function readPersistedTechnicalSummary(ctx: ReviewContext): TechnicalSummary | null {
	const raw = readArtifactJson<unknown>(ctx, TECHNICAL_SUMMARY_FILE);
	return raw ? parseTechnicalSummary(raw) : null;
}

/** Fallback para runs antigas: reconstrói os destaques dos artefatos de AST. */
function buildTechnicalFallback(
	ctx: ReviewContext,
	classification: RunClassification,
): TechnicalSummary {
	const ast = readArtifactJson<{ files?: Record<string, AstAnalysis> }>(
		ctx,
		"ast-summary.json",
	);
	return buildTechnicalSummary({
		classification,
		ast: ast?.files ? new Map(Object.entries(ast.files)) : undefined,
		impact: readArtifactJson<AstImpact>(ctx, "ast-impact.json") ?? undefined,
		headSha: classification.headSha,
	});
}

/**
 * Grava um `review.<watchdog>.md` por watchdog com achados e devolve o índice.
 * Mantém o `review.md` consolidado navegável em PRs grandes (centenas de achados).
 */
function writeDomainReports(
	ctx: ReviewContext,
	branch: string,
	reports: WatchdogReport[],
	classification: ClassificationResult,
	context: ContextSummary | null,
	nameOf: (id: string) => string,
): DomainReport[] {
	const domains: DomainReport[] = [];
	const renderer = new ReportRenderer(nameOf);
	for (const report of reports) {
		const findings = dedupeFindings([report]);
		if (findings.length === 0) continue;
		const file = `review.${sanitizeBranch(report.watchdogId)}.md`;
		const expected = classification.watchdogs[report.watchdogId] ?? [];
		ctx.storage.writeArtifact(ctx.review.id, {
			name: file,
			kind: "domain-review",
			content: `${renderer.renderDomain(
				branch,
				report,
				findings,
				expected.length,
				context,
			)}\n`,
		});
		domains.push({
			id: report.watchdogId,
			name: nameOf(report.watchdogId),
			file,
			findings: findings.length,
			reviewedFiles: report.reviewedFiles.length,
			expectedFiles: expected.length,
		});
	}
	return domains;
}

export type FinalizeResult = {
	reportPath: string;
	blockers: number;
	attention: number;
	messages: string[];
};

/**
 * Passo 2 — consolida os findings em review.md.
 * Lança se houver findings pendentes (o CLI decide o exit code).
 */
export function finalize(
	opts: ReviewOptions,
	branch: string,
	config: HoundsmanConfig,
	ctx: ReviewContext,
): FinalizeResult {
	// `--finalize` só consolida um ciclo preparado (status `reviewing`). Sem esta
	// guarda, um prepare no-op seguido de `--finalize` reescreveria o relatório
	// anterior com a classificação antiga (perdendo os relatórios por domínio).
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
				"Se nada mudou desde a última revisão, o relatório anterior foi mantido; use `--full` para re-revisar.",
			],
		};
	}

	const classification = readClassification(ctx);
	const activeIds = Object.keys(classification.watchdogs);

	const messages: string[] = [];
	const { reports, pending, warnings } = ctx.work.readFindings(activeIds);
	messages.push(...warnings);
	const jev = readCandidates(ctx, config);
	const extras = readManifestExtras(ctx);
	const business = persistBusiness(ctx);
	const manifestBusiness: ManifestBusiness | undefined = business
		? { source: business.source, ...summarizeBusiness(business) }
		: extras.business;
	writeManifest(
		ctx,
		config,
		opts,
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
		readFile: fileReader(ctx.root),
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

	persistContext(ctx);
	const context = ctx.work.readContextSummary() ?? readPersistedContextSummary(ctx);
	const technical =
		readPersistedTechnicalSummary(ctx) ?? buildTechnicalFallback(ctx, classification);
	const nameOf = (id: string): string => findWatchdog(config, id)?.name ?? id;
	const domains = writeDomainReports(
		ctx,
		branch,
		reports,
		classification,
		context,
		nameOf,
	);
	const markdown = new ReportRenderer(nameOf).render(
		branch,
		reports,
		merged,
		{ classified: classification.watchdogs },
		context,
		jev.available ? jev.candidates : undefined,
		domains,
	);
	ctx.storage.writeArtifact(ctx.review.id, {
		name: REVIEW_FILE,
		kind: "review",
		content: `${incrementalNote(classification)}${markdown}\n`,
	});
	// Resumo final para leitura humana — não participa de nenhuma etapa seguinte.
	ctx.storage.writeArtifact(ctx.review.id, {
		name: REVIEW_RESUME_FILE,
		kind: "resume",
		content: renderReviewResume({
			branch,
			date: now.slice(0, 10),
			context,
			business,
			classification,
			findings: merged,
			technical,
		}),
	});

	const location = ctx.storage.location(ctx.review.id);
	messages.push(
		`Triagem: ${location} — ${Object.keys(state.findings).length} finding(s).`,
	);

	const blockers = merged.filter((f) => f.severity === "blocking").length;
	const attention = merged.filter((f) => f.severity === "attention").length;
	messages.push(
		`Relatório: ${location} — ${blockers} bloqueante(s), ${attention} atenção.`,
	);

	// O staging já cumpriu o papel (briefs/findings/contexto estão no storage).
	ctx.work.clean();

	return { reportPath: location, blockers, attention, messages };
}

/** Resolve a branch (opção explícita ou a atual do git). */
export function resolveBranch(
	opts: ReviewOptions,
	git: GitRepository = new GitRepository(),
): string {
	if (opts.branch) return opts.branch;
	const branch = git.currentBranch();
	if (!branch) {
		throw new Error("Não foi possível detectar a branch. Use --branch <nome>.");
	}
	return branch;
}
