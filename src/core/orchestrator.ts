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
import { join, relative } from "node:path";
import { renderBrief } from "./brief";
import {
	type HoundsmanConfig,
	resolveJevConcurrency,
	resolveMaxFilesPerBrief,
} from "./config";
import { collectDiff, type DiffSource } from "./diff-source";
import { discoverDocs } from "./doc-discoverer";
import {
	type BudgetSelection,
	type ClassificationResult,
	classifyRange,
	selectByBudget,
} from "./file-classifier";
import { buildStateFromFindings, FindingsStateStore, fileReader } from "./findings-state";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
} from "./jev";
import { ARTIFACT_DIR, OUTPUT_FORMAT_PATH } from "./paths";
import { contextPaths, currentBranch, readContextSummary } from "./pr-context";
import {
	type ContextSummary,
	type DomainReport,
	dedupeFindings,
	parseWatchdogReport,
	renderDomainReport,
	renderReport,
	sanitizeBranch,
	type WatchdogReport,
} from "./report-builder";
import { writeRunStatus } from "./run-status";
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
	};
}

/** Caminho relativo à raiz, sempre com `/` (portável/legível). */
function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

type Paths = {
	slug: string;
	outDir: string;
	briefsDir: string;
	findingsDir: string;
};

function paths(opts: ReviewOptions, branch: string): Paths {
	const slug = sanitizeBranch(branch);
	const outDir = join(opts.dir, slug);
	return {
		slug,
		outDir,
		briefsDir: join(outDir, "briefs"),
		findingsDir: join(outDir, "findings"),
	};
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
// Findings
// ---------------------------------------------------------------------------

function readFindings(
	findingsDir: string,
	activeIds: string[],
): { reports: WatchdogReport[]; pending: string[] } {
	const reports: WatchdogReport[] = [];
	const pending: string[] = [];
	for (const id of activeIds) {
		const path = join(findingsDir, `${id}.json`);
		if (!existsSync(path)) {
			pending.push(id);
			continue;
		}
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const report = parseWatchdogReport(raw, path);
			if (report) reports.push(report);
			else pending.push(id);
		} catch (err) {
			console.error(
				`[houndsman] ${relFromRoot(path)} inválido: ${err instanceof Error ? err.message : err}`,
			);
			pending.push(id);
		}
	}
	return { reports, pending };
}

// ---------------------------------------------------------------------------
// Manifesto
// ---------------------------------------------------------------------------

function contextManifest(
	opts: ReviewOptions,
	branch: string,
): { summarized: boolean; source: ContextSummary["source"] | null } {
	const summary = readContextSummary(contextPaths(opts.dir, branch).summary);
	if (!summary) return { summarized: false, source: null };
	return { summarized: true, source: summary.source ?? null };
}

function writeManifest(
	outDir: string,
	opts: ReviewOptions,
	branch: string,
	classification: ClassificationResult,
	activeIds: string[],
	pending: string[],
	jev: JevCandidatesFile,
	config: HoundsmanConfig,
): void {
	const maxFilesPerBrief = resolveMaxFilesPerBrief(config);
	let filesOverBudget = 0;
	const watchdogs = activeIds.map((id) => {
		const selection = budgetFor(classification, id, maxFilesPerBrief);
		filesOverBudget += selection.overflow.length;
		return {
			id,
			name: findWatchdog(config, id)?.name ?? id,
			files: selection.selected,
			overflow: selection.overflow.length,
			brief: relFromRoot(join(outDir, "briefs", `${id}.md`)),
			findings: relFromRoot(join(outDir, "findings", `${id}.json`)),
			status: pending.includes(id) ? "pending" : "done",
		};
	});

	const manifest = {
		branch,
		slug: sanitizeBranch(branch),
		base: opts.base,
		head: opts.head,
		generatedAt: new Date().toISOString(),
		outputFormat: OUTPUT_FORMAT_PATH,
		budget: { maxFilesPerBrief, filesOverBudget },
		churn: churnTotals(classification),
		watchdogs,
		context: contextManifest(opts, branch),
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
	writeFileSync(
		join(outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
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
	return selectByBudget(
		classification.watchdogs[id] ?? [],
		classification.churn,
		maxFiles,
	);
}

/** Totais de churn do diff (métricas do manifesto). */
function churnTotals(classification: ClassificationResult): {
	additions: number;
	deletions: number;
} {
	let additions = 0;
	let deletions = 0;
	for (const entry of Object.values(classification.churn ?? {})) {
		additions += entry.additions;
		deletions += entry.deletions;
	}
	return { additions, deletions };
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
	for (const id of activeIds) {
		const def = findWatchdog(config, id);
		if (!def) continue;
		const { selected, overflow } = budgetFor(classification, id, maxFilesPerBrief);
		const brief = renderBrief(def, {
			watchdogId: id,
			files: selected,
			statuses: classification.files,
			churn: classification.churn,
			overflow,
			deleted: classification.deleted,
			branch,
			outputPath: relFromRoot(join(dirs.findingsDir, `${id}.json`)),
			outputFormatPath: OUTPUT_FORMAT_PATH,
			docs,
			context,
			candidates: candidates.filter((c) => c.watchdogId === id),
		});
		writeFileSync(join(dirs.briefsDir, `${id}.md`), `${brief}\n`);
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
	const store = new JevCandidatesStore(
		join(dirs.outDir, "candidates.json"),
		config.watchdogIds,
	);
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

function printJevSummary(jev: JevCandidatesFile): void {
	if (!jev.available) {
		console.log(`Jev: pulado (${jev.reason}).`);
		return;
	}
	const skipped = jev.skipped?.length ?? 0;
	console.log(
		`Jev: ${jev.candidates.length} candidato(s) em ${jev.analyzedFiles ?? 0} arquivo(s)` +
			(skipped > 0 ? `, ${skipped} com falha.` : "."),
	);
}

function printDiscovery(
	activeIds: string[],
	classification: ClassificationResult,
	briefsDir: string,
): void {
	console.log(
		`Discovery: ${activeIds.length} watchdog(s) ativado(s), ${Object.keys(classification.files).length} arquivo(s), ${classification.deleted.length} deletado(s).`,
	);
	console.log(`Briefs: ${relFromRoot(briefsDir)}/`);
	for (const file of classification.deleted) {
		console.log(`Deletado (breaking change): ${file}`);
	}
}

/** Resumo do orçamento — só quando algum arquivo ficou de fora (PR grande). */
function printBudget(
	classification: ClassificationResult,
	config: HoundsmanConfig,
): void {
	const maxFiles = resolveMaxFilesPerBrief(config);
	let overflow = 0;
	for (const id of Object.keys(classification.watchdogs)) {
		overflow += budgetFor(classification, id, maxFiles).overflow.length;
	}
	if (overflow === 0) return;
	console.log(
		`Orçamento: ${maxFiles} arquivo(s)/brief — ${overflow} fora do orçamento (menor churn; registrar em skipped).`,
	);
}

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export async function prepare(
	opts: ReviewOptions,
	branch: string,
	config: HoundsmanConfig,
	dirs: Paths = paths(opts, branch),
): Promise<void> {
	prepareDirs(dirs, opts.clean);

	// Marca o run como "revisando" (reinicia o ciclo) — a UI mostra o status.
	writeRunStatus(dirs.outDir, { branch, status: "reviewing", resetStartedAt: true });

	// Um único diff para toda a execução (churn + patch) — antes: 1 spawn por arquivo.
	const diff = collectDiff(opts.base, opts.head);
	const classification = classifyRange(opts.base, opts.head, config, diff);
	writeFileSync(
		join(dirs.outDir, "classification.json"),
		`${JSON.stringify(classification, null, 2)}\n`,
	);

	const jev = await resolveCandidates(opts, classification, dirs, config, diff);

	const activeIds = Object.keys(classification.watchdogs);
	if (Object.keys(classification.files).length === 0) {
		writeRunStatus(dirs.outDir, { branch, status: "review_done" });
		console.log(`Nenhuma alteração entre ${opts.base}...${opts.head}.`);
		return;
	}
	if (activeIds.length === 0) {
		writeRunStatus(dirs.outDir, { branch, status: "review_done" });
		console.log("Nenhum arquivo revisável (tudo excluído, deletado ou irrelevante).");
		return;
	}

	const context = readContextSummary(contextPaths(opts.dir, branch).summary);

	writeBriefs(activeIds, classification, dirs, branch, context, jev.candidates, config);
	writeManifest(
		dirs.outDir,
		opts,
		branch,
		classification,
		activeIds,
		activeIds,
		jev,
		config,
	);
	printDiscovery(activeIds, classification, dirs.briefsDir);
	printBudget(classification, config);
	printJevSummary(jev);

	if (context) {
		console.log("Contexto da PR resumido e injetado nos briefs.");
	} else {
		console.log(
			"Sem contexto da PR (rode `bun run houndsman context` antes, se houver PR).",
		);
	}

	console.log(
		`\nPróximo passo: despachar os sub-agentes (um por brief em ${relFromRoot(dirs.briefsDir)}/).`,
	);
	console.log("Quando os findings estiverem gravados: bun run houndsman --finalize");
}

// ---------------------------------------------------------------------------
// Passo 2 — finalizar
// ---------------------------------------------------------------------------

/** Lê o classification.json gravado pelo passo de preparação (lança se ausente). */
function readClassification(classificationPath: string): ClassificationResult {
	if (!existsSync(classificationPath)) {
		throw new Error(
			`Não encontrei ${relFromRoot(classificationPath)}. Rode \`bun run houndsman\` (preparar) primeiro.`,
		);
	}
	const parsed = JSON.parse(
		readFileSync(classificationPath, "utf8"),
	) as ClassificationResult;
	return parsed;
}

/**
 * Grava um `review.<watchdog>.md` por watchdog com achados e devolve o índice.
 * Mantém o `review.md` consolidado navegável em PRs grandes (centenas de achados).
 */
function writeDomainReports(
	outDir: string,
	branch: string,
	reports: WatchdogReport[],
	classification: ClassificationResult,
	context: ContextSummary | null,
	nameOf: (id: string) => string,
): DomainReport[] {
	const domains: DomainReport[] = [];
	for (const report of reports) {
		const findings = dedupeFindings([report]);
		if (findings.length === 0) continue;
		const file = `review.${sanitizeBranch(report.watchdogId)}.md`;
		const expected = classification.watchdogs[report.watchdogId] ?? [];
		writeFileSync(
			join(outDir, file),
			`${renderDomainReport(
				branch,
				report,
				findings,
				expected.length,
				context,
				nameOf,
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
	const classification = readClassification(join(dirs.outDir, "classification.json"));
	const activeIds = Object.keys(classification.watchdogs);

	const { reports, pending } = readFindings(dirs.findingsDir, activeIds);
	const jev =
		new JevCandidatesStore(
			join(dirs.outDir, "candidates.json"),
			config.watchdogIds,
		).read() ?? JevCandidatesStore.unavailable("candidates.json ausente");
	writeManifest(
		dirs.outDir,
		opts,
		branch,
		classification,
		activeIds,
		pending,
		jev,
		config,
	);

	if (pending.length > 0) {
		throw new Error(
			`Faltam ${pending.length}/${activeIds.length} findings: ${pending.join(", ")}.\n` +
				`Cada watchdog deve gravar ${relFromRoot(dirs.findingsDir)}/<id>.json (schema ${OUTPUT_FORMAT_PATH}).`,
		);
	}

	const merged = dedupeFindings(reports);

	// Estado de triagem: preserva o que já existia (casando por fingerprint) e
	// anexa o `id` de cada finding aos itens do relatório. A linha é cache —
	// recalculada por `houndsman findings sync` após edições.
	const store = FindingsStateStore.at(opts.dir, branch);
	const state = buildStateFromFindings(merged, {
		branch,
		readFile: fileReader(process.cwd()),
		previous: store.read(),
	});
	store.write(state);
	console.log(
		`Triagem: ${relFromRoot(store.filePath)} — ${Object.keys(state.findings).length} finding(s).`,
	);
	writeRunStatus(dirs.outDir, { branch, status: "review_done" });

	const context = readContextSummary(contextPaths(opts.dir, branch).summary);
	const nameOf = (id: string): string => findWatchdog(config, id)?.name ?? id;
	const domains = writeDomainReports(
		dirs.outDir,
		branch,
		reports,
		classification,
		context,
		nameOf,
	);
	const markdown = renderReport(
		branch,
		reports,
		merged,
		{ classified: classification.watchdogs },
		context,
		jev.available ? jev.candidates : undefined,
		nameOf,
		domains,
	);
	const reportPath = join(dirs.outDir, "review.md");
	writeFileSync(reportPath, `${markdown}\n`);

	const blockers = merged.filter((f) => f.severity === "blocking").length;
	const attention = merged.filter((f) => f.severity === "attention").length;
	console.log(
		`Relatório: ${relFromRoot(reportPath)} — ${blockers} bloqueante(s), ${attention} atenção.`,
	);

	return { reportPath, blockers, attention };
}

/** Resolve a branch (opção explícita ou a atual do git). */
export function resolveBranch(opts: ReviewOptions): string {
	return opts.branch ?? currentBranch();
}
