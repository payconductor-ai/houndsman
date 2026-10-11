/**
 * Orquestração do houndsman (biblioteca): preparar (classificação + briefs +
 * manifesto + Jev) e finalizar (findings → dedupe → relatório).
 *
 * Genérico: recebe o `ReviewConfig` por parâmetro (injeção explícita).
 * Entrypoints: `cli/index.ts` (`houndsman`). Aqui não há `process.argv`.
 *
 * Artefatos (em `opts.dir`, default `ReviewConfig.artifactDir/<branch-slug>/`):
 *   classification.json   revisores ativados por arquivo + status (A/M/D/R)
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
	DEFAULT_ARTIFACT_DIR,
	type ReviewConfig,
	resolveOutputFormatPath,
} from "./config";
import { discoverDocs } from "./doc-discoverer";
import { type ClassificationResult, classifyRange } from "./file-classifier";
import {
	type JevCandidate,
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
} from "./jev";
import { contextPaths, currentBranch, readContextSummary } from "./pr-context";
import {
	type ContextSummary,
	dedupeFindings,
	parseReviewerReport,
	type ReviewerReport,
	renderReport,
	sanitizeBranch,
} from "./report-builder";
import { findReviewer } from "./reviewer-registry";
import type { ReviewerMeta } from "./types";

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
export function defaultOptions(
	artifactDir: string = DEFAULT_ARTIFACT_DIR,
): ReviewOptions {
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
): { reports: ReviewerReport[]; pending: string[] } {
	const reports: ReviewerReport[] = [];
	const pending: string[] = [];
	for (const id of activeIds) {
		const path = join(findingsDir, `${id}.json`);
		if (!existsSync(path)) {
			pending.push(id);
			continue;
		}
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const report = parseReviewerReport(raw, path);
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
	config: ReviewConfig,
): void {
	const manifest = {
		branch,
		slug: sanitizeBranch(branch),
		base: opts.base,
		head: opts.head,
		generatedAt: new Date().toISOString(),
		outputFormat: resolveOutputFormatPath(config),
		reviewers: activeIds.map((id) => ({
			id,
			name: findReviewer(config, id)?.name ?? id,
			files: classification.reviewers[id] ?? [],
			brief: relFromRoot(join(outDir, "briefs", `${id}.md`)),
			findings: relFromRoot(join(outDir, "findings", `${id}.json`)),
			status: pending.includes(id) ? "pending" : "done",
		})),
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
// Briefs
// ---------------------------------------------------------------------------

function writeBriefs(
	activeIds: string[],
	classification: ClassificationResult,
	dirs: Paths,
	branch: string,
	context: ContextSummary | null,
	candidates: JevCandidate[],
	config: ReviewConfig,
): void {
	const docs = discoverDocs(Object.keys(classification.files), config);
	for (const id of activeIds) {
		const def = findReviewer(config, id);
		if (!def) continue;
		const files = classification.reviewers[id] ?? [];
		const brief = renderBrief(def, {
			reviewerId: id,
			files,
			statuses: classification.files,
			deleted: classification.deleted,
			branch,
			outputPath: relFromRoot(join(dirs.findingsDir, `${id}.json`)),
			outputFormatPath: resolveOutputFormatPath(config),
			docs,
			context,
			candidates: candidates.filter((c) => c.reviewerId === id),
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
	config: ReviewConfig,
): Promise<JevCandidatesFile> {
	const store = new JevCandidatesStore(
		join(dirs.outDir, "candidates.json"),
		config.reviewerIds,
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
			config.reviewers as Record<string, ReviewerMeta>,
		);
		const result = await detector.detect(classification, opts.base, opts.head);
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
		`Discovery: ${activeIds.length} revisor(es) ativado(s), ${Object.keys(classification.files).length} arquivo(s), ${classification.deleted.length} deletado(s).`,
	);
	console.log(`Briefs: ${relFromRoot(briefsDir)}/`);
	for (const file of classification.deleted) {
		console.log(`Deletado (breaking change): ${file}`);
	}
}

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export async function prepare(
	opts: ReviewOptions,
	branch: string,
	config: ReviewConfig,
	dirs: Paths = paths(opts, branch),
): Promise<void> {
	prepareDirs(dirs, opts.clean);

	const classification = classifyRange(opts.base, opts.head, config);
	writeFileSync(
		join(dirs.outDir, "classification.json"),
		`${JSON.stringify(classification, null, 2)}\n`,
	);

	const jev = await resolveCandidates(opts, classification, dirs, config);

	const activeIds = Object.keys(classification.reviewers);
	if (Object.keys(classification.files).length === 0) {
		console.log(`Nenhuma alteração entre ${opts.base}...${opts.head}.`);
		return;
	}
	if (activeIds.length === 0) {
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
	return JSON.parse(readFileSync(classificationPath, "utf8"));
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
	config: ReviewConfig,
	dirs: Paths = paths(opts, branch),
): FinalizeResult {
	const classification = readClassification(join(dirs.outDir, "classification.json"));
	const activeIds = Object.keys(classification.reviewers);

	const { reports, pending } = readFindings(dirs.findingsDir, activeIds);
	const jev =
		new JevCandidatesStore(
			join(dirs.outDir, "candidates.json"),
			config.reviewerIds,
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
				`Cada revisor deve gravar ${relFromRoot(dirs.findingsDir)}/<id>.json (schema ${config.outputFormatPath}).`,
		);
	}

	const merged = dedupeFindings(reports);
	const context = readContextSummary(contextPaths(opts.dir, branch).summary);
	const markdown = renderReport(
		branch,
		reports,
		merged,
		{ classified: classification.reviewers },
		context,
		jev.available ? jev.candidates : undefined,
		(id) => findReviewer(config, id)?.name ?? id,
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
