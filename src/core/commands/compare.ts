/**
 * Comando `compare` (biblioteca) — compara duas runs da mesma branch.
 *
 * Resolve o par por slug (como na URL da UI) ou por `(branch, variante)`, lê os
 * artefatos de cada review e grava `compare-<a>--<b>.md|.json` na run B.
 */

import {
	buildComparison,
	type ComparisonFinding,
	comparisonToJson,
	countBySeverity,
	type ReviewSnapshot,
	renderComparison,
} from "../compare";
import { currentBranch } from "../pr-context";
import type { RepoIdentity, ReviewRecord, StorageProvider } from "../storage/types";
import type { Severity } from "../types";

/** Seleção do par A/B. */
export type CompareOptions = {
	/** Slugs prontos (como exibidos na UI). */
	slugA?: string;
	slugB?: string;
	/** Identidade alternativa: branch + rótulos de variante. */
	branch?: string;
	variantA?: string;
	variantB?: string;
};

/** Resultado do comando. */
export type CompareResult = {
	markdown: string;
	json: string;
	a: ReviewRecord;
	b: ReviewRecord;
	artifacts: { markdown: string; json: string };
};

type ManifestShape = {
	watchdogs?: { files?: string[]; overflow?: number }[];
	ai?: { model?: string };
};

type ReportShape = { durationMs?: number };
type HuntShape = {
	model?: string;
	durationMs?: number;
	totals?: { totalTokens?: number; costUsd?: number };
};
type AiUsageShape = { total?: { totalTokens?: number } };

/** Resolve a run pelo slug dentro do repositório. */
function bySlug(
	storage: StorageProvider,
	repo: RepoIdentity,
	slug: string,
): ReviewRecord {
	const review = storage
		.listReviews(repo.key)
		.find((candidate) => candidate.slug === slug);
	if (!review) throw new Error(`Nenhuma run com slug '${slug}' neste repositório.`);
	return review;
}

/** Resolve o par A/B (slug ou branch + variantes). */
export function resolveComparePair(
	storage: StorageProvider,
	repo: RepoIdentity,
	options: CompareOptions,
): [ReviewRecord, ReviewRecord] {
	if (options.slugA && options.slugB) {
		return [
			bySlug(storage, repo, options.slugA),
			bySlug(storage, repo, options.slugB),
		];
	}
	const branch = options.branch ?? currentBranch();
	const variantB = options.variantB?.trim();
	if (!variantB) {
		throw new Error(
			"Informe --b <variante> (ou passe dois slugs: `houndsman compare <a> <b>`).",
		);
	}
	const a = storage.findReview(repo.key, branch, options.variantA);
	const b = storage.findReview(repo.key, branch, variantB);
	if (!a) {
		throw new Error(
			`Nenhuma revisão para '${branch}'${options.variantA ? ` (variante '${options.variantA}')` : ""}.`,
		);
	}
	if (!b) throw new Error(`Nenhuma revisão para '${branch}' (variante '${variantB}').`);
	return [a, b];
}

function readJson<T>(storage: StorageProvider, reviewId: string, name: string): T | null {
	const artifact = storage.readArtifact(reviewId, name);
	if (!artifact) return null;
	try {
		return JSON.parse(artifact.content) as T;
	} catch {
		return null;
	}
}

/** Extrai o snapshot comparável de uma run. */
function snapshotOf(
	storage: StorageProvider,
	review: ReviewRecord,
	label: string,
): ReviewSnapshot {
	const state = storage.readFindings(review.id);
	const findings: ComparisonFinding[] = Object.values(state?.findings ?? {})
		.filter((finding) => finding.present)
		.map((finding) => ({
			fingerprint: finding.fingerprint,
			rule: finding.rule,
			severity: finding.severity,
			file: finding.file,
			line: finding.line ?? undefined,
			message: finding.message,
			watchdogs: finding.watchdogIds,
		}));

	const manifest = readJson<ManifestShape>(storage, review.id, "manifest.json");
	const prepare = readJson<ReportShape>(storage, review.id, "prepare-report.json");
	const hunt = readJson<HuntShape>(storage, review.id, "hunt-report.json");
	const aiUsage = readJson<AiUsageShape>(storage, review.id, "ai-usage.json");

	const started = review.startedAt ? Date.parse(review.startedAt) : Number.NaN;
	const reviewed = review.reviewedAt ? Date.parse(review.reviewedAt) : Number.NaN;
	const durationMs =
		Number.isFinite(started) && Number.isFinite(reviewed) && reviewed >= started
			? reviewed - started
			: undefined;

	const watchdogs = manifest?.watchdogs ?? [];
	// Domínios se sobrepõem: conta arquivos únicos, não "slots" por watchdog.
	const files = new Set<string>();
	for (const watchdog of watchdogs) {
		for (const file of watchdog.files ?? []) files.add(file);
	}
	return {
		label,
		slug: review.slug,
		branch: review.branch,
		variant: review.variant,
		headSha: review.headSha ?? review.reviewedSha,
		model: hunt?.model ?? manifest?.ai?.model,
		findings,
		bySeverity: countBySeverity(findings),
		coverage: {
			watchdogs: watchdogs.length,
			files: files.size,
			overflow: watchdogs.reduce(
				(total, watchdog) => total + (watchdog.overflow ?? 0),
				0,
			),
		},
		durationMs,
		prepareMs: prepare?.durationMs,
		huntMs: hunt?.durationMs,
		tokens: hunt?.totals?.totalTokens ?? aiUsage?.total?.totalTokens,
		costUsd: hunt?.totals?.costUsd,
	};
}

/** Executa a comparação e persiste o relatório na run B. */
export function runCompare(
	storage: StorageProvider,
	repo: RepoIdentity,
	options: CompareOptions,
): CompareResult {
	const [a, b] = resolveComparePair(storage, repo, options);
	const comparison = buildComparison(
		snapshotOf(storage, a, "A"),
		snapshotOf(storage, b, "B"),
	);
	const markdown = renderComparison(comparison);
	const json = comparisonToJson(comparison);
	const base = `compare-${a.slug}--${b.slug}`;
	storage.writeArtifact(b.id, {
		name: `${base}.md`,
		kind: "compare",
		content: markdown,
	});
	storage.writeArtifact(b.id, {
		name: `${base}.json`,
		kind: "compare",
		content: json,
	});
	return {
		markdown,
		json,
		a,
		b,
		artifacts: { markdown: `${base}.md`, json: `${base}.json` },
	};
}

/** Linha da listagem de variantes da branch. */
export type CompareListItem = {
	slug: string;
	branch: string;
	variant?: string;
	status: ReviewRecord["status"];
	findings: number;
	bySeverity: Record<Severity, number>;
	updatedAt: string;
};

/** Lista as runs do repositório (filtra por branch quando informado). */
export function listRunsForCompare(
	storage: StorageProvider,
	repo: RepoIdentity,
	branch?: string,
): CompareListItem[] {
	return storage
		.listReviews(repo.key)
		.filter((review) => !branch || review.branch === branch)
		.map((review) => {
			const snapshot = snapshotOf(storage, review, review.variant ?? "principal");
			return {
				slug: review.slug,
				branch: review.branch,
				variant: review.variant,
				status: review.status,
				findings: snapshot.findings.length,
				bySeverity: snapshot.bySeverity,
				updatedAt: review.updatedAt,
			};
		});
}
