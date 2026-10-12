/**
 * Classificação de arquivos alterados por domínio de review (biblioteca).
 *
 * Cada watchdog declara os arquivos que cobre (`classify`); exclusões chegam via
 * `HoundsmanConfig`. Use `classifyRange(base, head, config)`.
 */

import { readFileSync } from "node:fs";
import type { HoundsmanConfig } from "./config";
import type { ClassifyRule, WatchdogDefinition } from "./types";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

type FileEntry = {
	path: string;
	status: FileStatus;
	oldPath?: string;
};

export type ClassificationResult = {
	/** watchdogId → file paths (apenas arquivos revisáveis) */
	watchdogs: Record<string, string[]>;
	/** path → metadados (status, oldPath) */
	files: Record<string, { status: FileStatus; oldPath?: string }>;
	/** Arquivos não classificados (revisar manualmente) */
	unclassified: string[];
	/** Arquivos excluídos da revisão (gerados, locks, builds) */
	excluded: string[];
	/** Arquivos deletados — candidatos a breaking change, sem conteúdo para ler */
	deleted: string[];
	/** Estatísticas por watchdog */
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
	watchdogs: Record<TId, WatchdogDefinition>,
	watchdogIds: readonly TId[],
): boolean {
	return watchdogIds.some((id) =>
		watchdogs[id]?.classify?.some((rule) => rule.type === "content"),
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

/** Watchdogs que declaram o arquivo (união dos `classify`). */
export function matchWatchdogs<TId extends string>(
	filePath: string,
	watchdogs: Record<TId, WatchdogDefinition>,
	watchdogIds: readonly TId[],
	content?: string,
): TId[] {
	const ids: TId[] = [];
	for (const id of watchdogIds) {
		if (
			watchdogs[id]?.classify?.some((rule) =>
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
	config: HoundsmanConfig<TId>,
): ClassificationResult {
	const watchdogFiles: Record<string, string[]> = {};
	const files: ClassificationResult["files"] = {};
	const unclassified: string[] = [];
	const excluded: string[] = [];
	const deleted: string[] = [];
	// Leitura de conteúdo só é habilitada se algum watchdog declarar regra `content`.
	const needsContent = hasContentRules(config.watchdogs, config.watchdogIds);

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
		const ids: string[] = matchWatchdogs(
			path,
			config.watchdogs,
			config.watchdogIds,
			content,
		);

		if (ids.length === 0) {
			unclassified.push(path);
			continue;
		}

		for (const id of ids) {
			watchdogFiles[id] ??= [];
			watchdogFiles[id].push(path);
		}
	}

	const watchdogs: Record<string, string[]> = {};
	const stats: Record<string, number> = {};
	for (const id of config.watchdogIds) {
		const list = [...new Set(watchdogFiles[id] ?? [])];
		if (list.length > 0) {
			watchdogs[id] = list;
			stats[id] = list.length;
		}
	}

	return {
		watchdogs,
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
	config: HoundsmanConfig<TId>,
): ClassificationResult {
	const entries = parseEntries(runGitDiff(base, head));
	const result = classifyEntries(entries, config);
	result.base = base;
	result.head = head;
	return result;
}
