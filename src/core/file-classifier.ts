/**
 * Classificação de arquivos alterados por domínio de review (biblioteca).
 *
 * Cada revisor declara os arquivos que cobre (`classify`); exclusões chegam via
 * `ReviewConfig`. Use `classifyRange(base, head, config)`.
 */

import { readFileSync } from "node:fs";
import type { ReviewConfig } from "./config";
import type { ClassifyRule, ReviewerDefinition } from "./types";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

type FileEntry = {
	path: string;
	status: FileStatus;
	oldPath?: string;
};

export type ClassificationResult = {
	/** reviewerId → file paths (apenas arquivos revisáveis) */
	reviewers: Record<string, string[]>;
	/** path → metadados (status, oldPath) */
	files: Record<string, { status: FileStatus; oldPath?: string }>;
	/** Arquivos não classificados (revisar manualmente) */
	unclassified: string[];
	/** Arquivos excluídos da revisão (gerados, locks, builds) */
	excluded: string[];
	/** Arquivos deletados — candidatos a breaking change, sem conteúdo para ler */
	deleted: string[];
	/** Estatísticas por reviewer */
	stats: Record<string, number>;
	excludedCount: number;
	base?: string;
	head?: string;
};

// ---------------------------------------------------------------------------
// Matchers genéricos (reutilizados pelo projeto)
// ---------------------------------------------------------------------------

/** Tipo de classificação assumido quando `type` é omitido. */
const DEFAULT_CLASSIFY_TYPE: NonNullable<ClassifyRule["type"]> = "filename";

/** `true` se há entradas de conteúdo (as únicas que exigem ler o arquivo). */
function hasContentRules<TId extends string>(
	reviewers: Record<TId, ReviewerDefinition>,
	reviewerIds: readonly TId[],
): boolean {
	return reviewerIds.some((id) =>
		reviewers[id]?.classify?.some((rule) => rule.type === "content"),
	);
}

/** Lê o arquivo em UTF-8; `undefined` se indisponível (binário, ausente). */
function readFileContent(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** `true` se o arquivo casa a entrada de classificação. */
function matchesClassifyRule(
	filePath: string,
	rule: ClassifyRule,
	content: string | undefined,
): boolean {
	if ((rule.type ?? DEFAULT_CLASSIFY_TYPE) === "content") {
		return content !== undefined && new RegExp(rule.value).test(content);
	}
	return new RegExp(rule.value).test(filePath);
}

/** Revisores que declaram o arquivo (união dos `classify`). */
export function matchReviewers<TId extends string>(
	filePath: string,
	reviewers: Record<TId, ReviewerDefinition>,
	reviewerIds: readonly TId[],
	content?: string,
): TId[] {
	const ids: TId[] = [];
	for (const id of reviewerIds) {
		if (
			reviewers[id]?.classify?.some((rule) =>
				matchesClassifyRule(filePath, rule, content),
			)
		) {
			ids.push(id);
		}
	}
	return ids;
}

/** `true` se o arquivo casa algum padrão de exclusão. */
export function isExcludedPath(filePath: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(filePath));
}

// ---------------------------------------------------------------------------
// Execução do git diff
// ---------------------------------------------------------------------------

function runGitDiff(base: string, head: string): string {
	const result = Bun.spawnSync(["git", "diff", `${base}...${head}`, "--name-status"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`git diff falhou (base='${base}', head='${head}'): ${stderr}`);
	}
	return new TextDecoder().decode(result.stdout);
}

// ---------------------------------------------------------------------------
// Parsing de `git diff --name-status`
// ---------------------------------------------------------------------------

function mapStatus(code: string): FileStatus {
	const letter = code[0]?.toUpperCase();
	switch (letter) {
		case "A":
			return "added";
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		default:
			return "unknown";
	}
}

export function parseEntries(raw: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const fields = trimmed.split("\t");
		if (fields.length === 1) {
			// Sem status — assume modificado
			entries.push({ path: fields[0].trim(), status: "modified" });
			continue;
		}

		const status = mapStatus(fields[0].trim());
		if (fields.length >= 3 && (status === "renamed" || status === "copied")) {
			// R100\told\tnew
			entries.push({ path: fields[2].trim(), oldPath: fields[1].trim(), status });
		} else {
			entries.push({ path: fields[1].trim(), status });
		}
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

export function classifyEntries<TId extends string>(
	entries: FileEntry[],
	config: ReviewConfig<TId>,
): ClassificationResult {
	const reviewerFiles: Record<string, string[]> = {};
	const files: ClassificationResult["files"] = {};
	const unclassified: string[] = [];
	const excluded: string[] = [];
	const deleted: string[] = [];
	// Leitura de conteúdo só é habilitada se algum revisor declarar regra `content`.
	const needsContent = hasContentRules(config.reviewers, config.reviewerIds);

	for (const entry of entries) {
		const { path, status, oldPath } = entry;
		files[path] = oldPath ? { status, oldPath } : { status };

		if (isExcludedPath(path, config.exclusions)) {
			excluded.push(path);
			continue;
		}

		if (status === "deleted") {
			// Sem conteúdo para revisar — exposto separadamente p/ checagem de breaking change
			deleted.push(path);
			continue;
		}

		const content = needsContent ? readFileContent(path) : undefined;
		const ids: string[] = matchReviewers(
			path,
			config.reviewers,
			config.reviewerIds,
			content,
		);

		if (ids.length === 0) {
			unclassified.push(path);
			continue;
		}

		for (const id of ids) {
			reviewerFiles[id] ??= [];
			reviewerFiles[id].push(path);
		}
	}

	const reviewers: Record<string, string[]> = {};
	const stats: Record<string, number> = {};
	for (const id of config.reviewerIds) {
		const list = [...new Set(reviewerFiles[id] ?? [])];
		if (list.length > 0) {
			reviewers[id] = list;
			stats[id] = list.length;
		}
	}

	return {
		reviewers,
		files,
		unclassified,
		excluded,
		deleted,
		stats,
		excludedCount: excluded.length,
	};
}

/**
 * Executa `git diff` entre base e head e classifica os arquivos alterados.
 */
export function classifyRange<TId extends string>(
	base: string,
	head: string,
	config: ReviewConfig<TId>,
): ClassificationResult {
	const entries = parseEntries(runGitDiff(base, head));
	const result = classifyEntries(entries, config);
	result.base = base;
	result.head = head;
	return result;
}
