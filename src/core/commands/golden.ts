/**
 * Comando `golden` (biblioteca) — avalia runs contra defeitos congelados.
 *
 * A contagem de findings de duas variantes nunca é comparável: cada execução
 * amostra pontos diferentes do mesmo diff. Com um golden set (arquivo do
 * consumidor), a comparação vira recall/precisão sobre os defeitos que já
 * foram confirmados no código.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	commitMatches,
	type GoldenFinding,
	type GoldenRunScore,
	type GoldenSet,
	goldenToJson,
	parseGoldenSet,
	renderGoldenReport,
	scoreGolden,
} from "../golden";
import { normalizePath } from "../hunt/review-checks";
import { currentBranch } from "../pr-context";
import type { RepoIdentity, ReviewRecord, StorageProvider } from "../storage/types";

/** Seleção das runs a avaliar. */
export type GoldenOptions = {
	/** Caminho do arquivo de golden set. */
	file: string;
	/** Branch alvo (default: a atual). */
	branch?: string;
	/** Rótulo da variante; ausente = todas as runs da branch. */
	variant?: string;
	/** Slug explícito (vence `variant`). */
	slug?: string;
};

/** Resultado do comando. */
export type GoldenResult = {
	markdown: string;
	json: string;
	set: GoldenSet;
	runs: GoldenRunScore[];
	/** Run onde o relatório foi gravado (a mais recente avaliada). */
	target: ReviewRecord;
	artifacts?: { markdown: string; json: string };
};

/** Lê e valida o arquivo de golden set. */
export function loadGoldenSet(file: string): {
	set: GoldenSet;
	warnings: string[];
} {
	let content: string;
	try {
		content = readFileSync(resolve(file), "utf8");
	} catch (error) {
		throw new Error(
			`Golden set ilegível: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		throw new Error(`Golden set não é JSON válido: ${file}`);
	}
	const parsed = parseGoldenSet(raw);
	if (!parsed.set) {
		throw new Error(
			`Golden set inválido (${file}): ${parsed.warnings.join(" ")}`.trim(),
		);
	}
	return { set: parsed.set, warnings: parsed.warnings };
}

/** Findings presentes de uma run, no formato da avaliação. */
export function goldenFindingsOf(
	storage: StorageProvider,
	review: ReviewRecord,
): GoldenFinding[] {
	const state = storage.readFindings(review.id);
	return Object.values(state?.findings ?? {})
		.filter((finding) => finding.present)
		.map((finding) => ({
			fingerprint: finding.fingerprint,
			file: normalizePath(finding.file),
			line: finding.line ?? undefined,
			rule: finding.rule,
			severity: finding.severity,
			message: finding.message,
			evidence: finding.evidence,
			watchdogs: finding.watchdogIds,
		}));
}

/** Runs alvo: slug > variante > todas as da branch. */
function selectReviews(
	storage: StorageProvider,
	repo: RepoIdentity,
	options: GoldenOptions,
): ReviewRecord[] {
	const reviews = storage.listReviews(repo.key);
	if (options.slug) {
		const found = reviews.find((review) => review.slug === options.slug);
		if (!found) {
			throw new Error(`Nenhuma run com slug '${options.slug}' neste repositório.`);
		}
		return [found];
	}

	const branch = options.branch ?? currentBranch();
	const ofBranch = reviews.filter((review) => review.branch === branch);
	const variant = options.variant?.trim();
	const selected = variant
		? ofBranch.filter((review) => review.variant === variant)
		: ofBranch;
	if (selected.length === 0) {
		throw new Error(
			`Nenhuma revisão para '${branch}'${variant ? ` (variante '${variant}')` : ""}.`,
		);
	}
	return selected;
}

/** Rótulo curto da run (`otimizado-4` ou `principal`). */
function labelOf(review: ReviewRecord): string {
	return review.variant?.trim() || "principal";
}

/** Executa a avaliação e grava o relatório na run mais recente selecionada. */
export function runGolden(
	storage: StorageProvider,
	repo: RepoIdentity,
	options: GoldenOptions,
): GoldenResult {
	const { set } = loadGoldenSet(options.file);
	const reviews = selectReviews(storage, repo, options);
	const runs: GoldenRunScore[] = reviews.map((review) => {
		const findings = goldenFindingsOf(storage, review);
		const commit = review.headSha ?? review.reviewedSha;
		return {
			slug: review.slug,
			label: labelOf(review),
			variant: review.variant,
			scope: review.branch,
			commit,
			commitMismatch: !commitMatches(set.commit, commit),
			findings: findings.length,
			score: scoreGolden(set, findings),
		};
	});

	const markdown = renderGoldenReport(set, runs);
	const json = goldenToJson(set, runs);
	const target = reviews[0];
	const base = `golden-${target.slug}`;
	storage.writeArtifact(target.id, {
		name: `${base}.md`,
		kind: "golden",
		content: markdown,
	});
	storage.writeArtifact(target.id, {
		name: `${base}.json`,
		kind: "golden",
		content: json,
	});
	return {
		markdown,
		json,
		set,
		runs,
		target,
		artifacts: { markdown: `${base}.md`, json: `${base}.json` },
	};
}
