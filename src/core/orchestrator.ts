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
import { ReviewScopeResolver, type RunClassification } from "./engine/review-scope";
import type { BudgetSelection, ClassificationResult } from "./file-classifier";
import { buildStateFromFindings, fileReader } from "./findings-state";
import { resolveSha } from "./git-revision";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
	parseCandidates,
	serializeCandidates,
} from "./jev";
import { displayPath, OUTPUT_FORMAT_PATH, REVIEW_FILE } from "./paths";
import { currentBranch } from "./pr-context";
import { ProjectConfig } from "./project-config";
import { BriefRenderer } from "./renderers/brief-renderer";
import { ManifestWriter } from "./renderers/manifest-writer";
import { ReportRenderer } from "./renderers/report-renderer";
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
import type { ReviewRecord, StorageProvider } from "./storage/types";
import { ReviewWorkArea } from "./storage/work-area";
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
	/** Força review completo (ignora o modo incremental). */
	full: boolean;
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
		full: false,
	};
}

/** Contexto de uma run: storage + review + staging. */
export type ReviewContext = {
	storage: StorageProvider;
	review: ReviewRecord;
	work: ReviewWorkArea;
};

/** Cria o contexto de uma review existente. */
export function reviewContext(
	storage: StorageProvider,
	review: ReviewRecord,
): ReviewContext {
	return { storage, review, work: new ReviewWorkArea(review) };
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
): void {
	new ManifestWriter(
		ctx.storage,
		ctx.review,
		ctx.work,
		new ProjectConfig(config),
		opts,
	).write(classification, activeIds, pending, jev);
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

function writeBriefs(
	activeIds: string[],
	classification: ClassificationResult,
	ctx: ReviewContext,
	branch: string,
	context: ContextSummary | null,
	candidates: JevCandidate[],
	config: HoundsmanConfig,
): void {
	const work = ctx.work;
	const docs = discoverDocs(Object.keys(classification.files), config);
	const maxFilesPerBrief = resolveMaxFilesPerBrief(config);
	const renderer = new BriefRenderer();
	for (const id of activeIds) {
		const def = findWatchdog(config, id);
		if (!def) continue;
		const { selected, overflow } = budgetFor(classification, id, maxFilesPerBrief);
		const brief = renderer.render(new Watchdog(def), {
			watchdogId: id,
			files: selected,
			statuses: classification.files,
			churn: classification.churn,
			overflow,
			deleted: classification.deleted,
			branch,
			outputPath: work.findingFile(id),
			outputFormatPath: OUTPUT_FORMAT_PATH,
			docs,
			context,
			candidates: candidates.filter((c) => c.watchdogId === id),
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
): Promise<JevCandidatesFile> {
	const save = (data: JevCandidatesFile): JevCandidatesFile => {
		ctx.storage.writeArtifact(ctx.review.id, {
			name: "candidates.json",
			kind: "candidates",
			content: serializeCandidates(data),
		});
		return data;
	};

	if (opts.noJev) {
		return save(JevCandidatesStore.unavailable("desativado (--no-jev)"));
	}

	const client = new JevClient();
	if (!client.isConfigured()) {
		return save(JevCandidatesStore.unavailable("TYPESAFE_API_KEY não configurada"));
	}

	try {
		const detector = new JevDetector(
			client,
			config.watchdogs as Record<string, WatchdogMeta>,
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
	const messages = [
		`Discovery: ${activeIds.length} watchdog(s) ativado(s), ${Object.keys(classification.files).length} arquivo(s), ${classification.deleted.length} deletado(s).`,
		`Briefs: ${displayPath(briefsDir)}/`,
	];
	for (const file of classification.deleted) {
		messages.push(`Deletado (breaking change): ${file}`);
	}
	return messages;
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
export type PrepareResult = { messages: string[] };

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export async function prepare(
	opts: ReviewOptions,
	branch: string,
	config: HoundsmanConfig,
	ctx: ReviewContext,
): Promise<PrepareResult> {
	const messages: string[] = [];
	ctx.work.ensure();
	if (opts.clean) ctx.work.cleanFindings();
	ctx.storage.updateReview(ctx.review.id, { base: opts.base, head: opts.head });

	// Marca o run como "revisando" (reinicia o ciclo) — a UI mostra o status.
	writeRunStatus(ctx.storage, ctx.review.id, {
		status: "reviewing",
		resetStartedAt: true,
	});

	// Marca o commit revisado e decide entre review completo e incremental.
	const headSha = resolveSha(opts.head);
	const previous = ctx.storage.readFindings(ctx.review.id);
	const { classification, diff } = new ReviewScopeResolver(opts, config).resolve(
		previous,
		headSha,
	);
	ctx.storage.writeArtifact(ctx.review.id, {
		name: "classification.json",
		kind: "classification",
		content: `${JSON.stringify(classification, null, 2)}\n`,
	});

	const jev = await resolveCandidates(opts, classification, ctx, config, diff);

	const activeIds = Object.keys(classification.watchdogs);
	if (Object.keys(classification.files).length === 0) {
		writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });
		messages.push(
			classification.mode === "incremental"
				? `Nenhuma alteração desde a última revisão (${shortSha(classification.reviewedFrom ?? "")}).`
				: `Nenhuma alteração entre ${opts.base}...${opts.head}.`,
		);
		return { messages };
	}
	if (activeIds.length === 0) {
		writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });
		messages.push(
			"Nenhum arquivo revisável (tudo excluído, deletado ou irrelevante).",
		);
		return { messages };
	}
	if (classification.mode === "incremental") {
		messages.push(
			`Modo incremental: ${Object.keys(classification.files).length} arquivo(s) alterado(s) desde ${shortSha(classification.reviewedFrom ?? "")}; ${classification.carryover?.length ?? 0} finding(s) carregado(s) do review anterior.`,
		);
	}

	const context = ctx.work.readContextSummary() ?? readPersistedContextSummary(ctx);
	persistContext(ctx);

	writeBriefs(activeIds, classification, ctx, branch, context, jev.candidates, config);
	writeManifest(ctx, config, opts, classification, activeIds, activeIds, jev);

	messages.push(
		...discoveryMessages(activeIds, classification, ctx.work.briefsDir),
		...budgetMessage(classification, config),
		...jevSummary(jev),
	);

	if (context) {
		messages.push("Contexto da PR resumido e injetado nos briefs.");
	} else {
		messages.push(
			"Sem contexto da PR (rode `bun run houndsman context` antes, se houver PR).",
		);
	}

	messages.push(
		`\nPróximo passo: despachar os sub-agentes (um por brief em ${displayPath(ctx.work.briefsDir)}/).`,
		"Quando os findings estiverem gravados: bun run houndsman --finalize",
	);

	return { messages };
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
			parseCandidates(JSON.parse(artifact.content), config.watchdogIds) ??
			JevCandidatesStore.unavailable("candidates.json inválido")
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
	const classification = readClassification(ctx);
	const activeIds = Object.keys(classification.watchdogs);

	const messages: string[] = [];
	const { reports, pending, warnings } = ctx.work.readFindings(activeIds);
	messages.push(...warnings);
	const jev = readCandidates(ctx, config);
	writeManifest(ctx, config, opts, classification, activeIds, pending, jev);

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
		readFile: fileReader(process.cwd()),
		previous: ctx.storage.readFindings(ctx.review.id),
		now,
		headSha: classification.headSha,
		reviewed: classification.headSha
			? { headSha: classification.headSha, at: now }
			: undefined,
	});
	ctx.storage.writeFindings(ctx.review.id, state);
	ctx.storage.updateReview(ctx.review.id, {
		base: opts.base,
		head: opts.head,
		headSha: classification.headSha,
	});
	writeRunStatus(ctx.storage, ctx.review.id, { status: "review_done" });

	persistContext(ctx);
	const context = ctx.work.readContextSummary() ?? readPersistedContextSummary(ctx);
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
export function resolveBranch(opts: ReviewOptions): string {
	return opts.branch ?? currentBranch();
}
