/**
 * Orquestração do houndsman (biblioteca): preparar (classificação + briefs +
 * manifesto + Jev) e finalizar (findings → dedupe → relatório).
 *
 * Genérico: recebe o `HoundsmanConfig` por parâmetro (injeção explícita).
 * Entrypoints: `cli/index.ts` (`houndsman`). Aqui não há `process.argv`.
 *
 * Artefatos (em `opts.dir`, default `HoundsmanConfig.artifactDir/<branch-slug>/`):
 *   classification.json   watchdogs ativados por arquivo + status (A/M/D/R)
 *   candidates.json       candidatos da pré-análise Jev
 *   briefs/<id>.md        instruções prontas para cada sub-agente
 *   findings/<id>.json    saída dos sub-agentes (schema skill/OUTPUT-FORMAT.md)
 *   manifest.json         resumo do que foi ativado
 *   review.md             relatório final (gerado no finalize)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { buildStateFromFindings, FindingsStateStore, fileReader } from "./findings-state";
import { resolveSha } from "./git-revision";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
} from "./jev";
import { ARTIFACT_DIR, OUTPUT_FORMAT_PATH, relFromRoot } from "./paths";
import { currentBranch, readContextSummary } from "./pr-context";
import { ProjectConfig } from "./project-config";
import { BriefRenderer } from "./renderers/brief-renderer";
import { ManifestWriter } from "./renderers/manifest-writer";
import { ReportRenderer } from "./renderers/report-renderer";
import {
	type ContextSummary,
	type DomainReport,
	dedupeFindings,
	parseWatchdogReport,
	sanitizeBranch,
	type WatchdogReport,
} from "./report-builder";
import { RunLayout } from "./run-layout";
import { writeRunStatus } from "./run-status";
import { systemClock } from "./services/clock";
import type { WatchdogMeta } from "./types";
import { findWatchdog } from "./watchdog-registry";

export type ReviewOptions = {
	base: string;
	head: string;
	branch?: string;
	dir: string;
	finalize: boolean;
	failOnBlocking: boolean;
	clean: boolean;
	noJev: boolean;
	/** Força review completo (ignora o modo incremental). */
	full: boolean;
};

/** Valores default das opções (o CLI sobrepõe com as flags). */
export function defaultOptions(artifactDir: string = ARTIFACT_DIR): ReviewOptions {
	return {
		base: "main",
		head: "HEAD",
		dir: artifactDir,
		finalize: false,
		failOnBlocking: false,
		clean: false,
		noJev: false,
		full: false,
	};
}

/** Layout de uma run (paths de briefs/findings/artefatos). */
type Paths = RunLayout;

function paths(opts: ReviewOptions, branch: string): Paths {
	return new RunLayout(opts.dir, branch);
}

function prepareDirs(dirs: Paths, clean: boolean): void {
	mkdirSync(dirs.briefsDir, { recursive: true });
	mkdirSync(dirs.findingsDir, { recursive: true });
	if (clean) {
		rmSync(dirs.findingsDir, { recursive: true, force: true });
		mkdirSync(dirs.findingsDir, { recursive: true });
	}
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
// Findings
// ---------------------------------------------------------------------------

function readFindings(
	findingsDir: string,
	activeIds: string[],
): { reports: WatchdogReport[]; pending: string[]; warnings: string[] } {
	const reports: WatchdogReport[] = [];
	const pending: string[] = [];
	const warnings: string[] = [];
	for (const id of activeIds) {
		const path = join(findingsDir, `${id}.json`);
		if (!existsSync(path)) {
			pending.push(id);
			continue;
		}
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const report = parseWatchdogReport(raw, path, (message) =>
				warnings.push(message),
			);
			if (report) reports.push(report);
			else pending.push(id);
		} catch (err) {
			warnings.push(
				`[houndsman] ${relFromRoot(path)} inválido: ${err instanceof Error ? err.message : err}`,
			);
			pending.push(id);
		}
	}
	return { reports, pending, warnings };
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
	layout: RunLayout,
	config: HoundsmanConfig,
	opts: ReviewOptions,
	classification: RunClassification,
	activeIds: string[],
	pending: string[],
	jev: JevCandidatesFile,
): void {
	new ManifestWriter(layout, new ProjectConfig(config), opts).write(
		classification,
		activeIds,
		pending,
		jev,
	);
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

function writeBriefs(
	activeIds: string[],
	classification: ClassificationResult,
	dirs: Paths,
	branch: string,
	context: ContextSummary | null,
	candidates: JevCandidate[],
	config: HoundsmanConfig,
): void {
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
			outputPath: relFromRoot(dirs.findingFile(id)),
			outputFormatPath: OUTPUT_FORMAT_PATH,
			docs,
			context,
			candidates: candidates.filter((c) => c.watchdogId === id),
		});
		writeFileSync(dirs.briefFile(id), `${brief}\n`);
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
	dirs: Paths,
	config: HoundsmanConfig,
	diff: DiffSource,
): Promise<JevCandidatesFile> {
	const store = new JevCandidatesStore(dirs.candidatesFile, config.watchdogIds);
	const save = (data: JevCandidatesFile): JevCandidatesFile => {
		store.write(data);
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
		`Briefs: ${relFromRoot(briefsDir)}/`,
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
	dirs: Paths = paths(opts, branch),
): Promise<PrepareResult> {
	const messages: string[] = [];
	prepareDirs(dirs, opts.clean);

	// Marca o run como "revisando" (reinicia o ciclo) — a UI mostra o status.
	writeRunStatus(dirs.outDir, { branch, status: "reviewing", resetStartedAt: true });

	// Marca o commit revisado e decide entre review completo e incremental.
	const headSha = resolveSha(opts.head);
	const previous = FindingsStateStore.at(opts.dir, branch).read();
	const { classification, diff } = new ReviewScopeResolver(opts, config).resolve(
		previous,
		headSha,
	);
	writeFileSync(
		dirs.classificationFile,
		`${JSON.stringify(classification, null, 2)}\n`,
	);

	const jev = await resolveCandidates(opts, classification, dirs, config, diff);

	const activeIds = Object.keys(classification.watchdogs);
	if (Object.keys(classification.files).length === 0) {
		writeRunStatus(dirs.outDir, { branch, status: "review_done" });
		messages.push(
			classification.mode === "incremental"
				? `Nenhuma alteração desde a última revisão (${shortSha(classification.reviewedFrom ?? "")}).`
				: `Nenhuma alteração entre ${opts.base}...${opts.head}.`,
		);
		return { messages };
	}
	if (activeIds.length === 0) {
		writeRunStatus(dirs.outDir, { branch, status: "review_done" });
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

	const context = readContextSummary(dirs.contextPaths.summary);

	writeBriefs(activeIds, classification, dirs, branch, context, jev.candidates, config);
	writeManifest(dirs, config, opts, classification, activeIds, activeIds, jev);

	messages.push(
		...discoveryMessages(activeIds, classification, dirs.briefsDir),
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
		`\nPróximo passo: despachar os sub-agentes (um por brief em ${relFromRoot(dirs.briefsDir)}/).`,
		"Quando os findings estiverem gravados: bun run houndsman --finalize",
	);

	return { messages };
}

// ---------------------------------------------------------------------------
// Passo 2 — finalizar
// ---------------------------------------------------------------------------

/** Lê o classification.json gravado pelo passo de preparação (lança se ausente). */
function readClassification(classificationPath: string): RunClassification {
	if (!existsSync(classificationPath)) {
		throw new Error(
			`Não encontrei ${relFromRoot(classificationPath)}. Rode \`bun run houndsman\` (preparar) primeiro.`,
		);
	}
	const parsed = JSON.parse(
		readFileSync(classificationPath, "utf8"),
	) as RunClassification;
	return parsed;
}

/**
 * Grava um `review.<watchdog>.md` por watchdog com achados e devolve o índice.
 * Mantém o `review.md` consolidado navegável em PRs grandes (centenas de achados).
 */
function writeDomainReports(
	layout: RunLayout,
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
		writeFileSync(
			layout.file(file),
			`${renderer.renderDomain(
				branch,
				report,
				findings,
				expected.length,
				context,
			)}\n`,
		);
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
	dirs: Paths = paths(opts, branch),
): FinalizeResult {
	const classification = readClassification(dirs.classificationFile);
	const activeIds = Object.keys(classification.watchdogs);

	const messages: string[] = [];
	const { reports, pending, warnings } = readFindings(dirs.findingsDir, activeIds);
	messages.push(...warnings);
	const jev =
		new JevCandidatesStore(dirs.candidatesFile, config.watchdogIds).read() ??
		JevCandidatesStore.unavailable("candidates.json ausente");
	writeManifest(dirs, config, opts, classification, activeIds, pending, jev);

	if (pending.length > 0) {
		throw new Error(
			`Faltam ${pending.length}/${activeIds.length} findings: ${pending.join(", ")}.\n` +
				`Cada watchdog deve gravar ${relFromRoot(dirs.findingsDir)}/<id>.json (schema ${OUTPUT_FORMAT_PATH}).`,
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
	const store = FindingsStateStore.at(opts.dir, branch);
	const state = buildStateFromFindings(merged, {
		branch,
		readFile: fileReader(process.cwd()),
		previous: store.read(),
		now,
		headSha: classification.headSha,
		reviewed: classification.headSha
			? { headSha: classification.headSha, at: now }
			: undefined,
	});
	store.write(state);
	messages.push(
		`Triagem: ${relFromRoot(store.filePath)} — ${Object.keys(state.findings).length} finding(s).`,
	);
	writeRunStatus(dirs.outDir, { branch, status: "review_done" });

	const context = readContextSummary(dirs.contextPaths.summary);
	const nameOf = (id: string): string => findWatchdog(config, id)?.name ?? id;
	const domains = writeDomainReports(
		dirs,
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
	const reportPath = dirs.reviewFile;
	writeFileSync(reportPath, `${incrementalNote(classification)}${markdown}\n`);

	const blockers = merged.filter((f) => f.severity === "blocking").length;
	const attention = merged.filter((f) => f.severity === "attention").length;
	messages.push(
		`Relatório: ${relFromRoot(reportPath)} — ${blockers} bloqueante(s), ${attention} atenção.`,
	);

	return { reportPath, blockers, attention, messages };
}

/** Resolve a branch (opção explícita ou a atual do git). */
export function resolveBranch(opts: ReviewOptions): string {
	return opts.branch ?? currentBranch();
}
