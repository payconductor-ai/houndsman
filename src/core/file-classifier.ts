/**
 * Classificação de arquivos alterados por domínio de review (biblioteca).
 *
 * Cada watchdog declara os arquivos que cobre (`classify`); exclusões chegam via
 * `HoundsmanConfig`. Use `classifyRange(base, head, config)`.
 */

import { readFileSync } from "node:fs";
import type { AstFacts } from "./ast/types";
import type { HoundsmanConfig } from "./config";
import { churnToRecord, collectChurn, type DiffSource } from "./diff-source";
import { matchesClassifyRule } from "./domain/watchdog";
import { runGit } from "./git-runner";
import type { ChurnMap, WatchdogDefinition } from "./types";

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
	/** path → linhas adicionadas/removidas (churn do diff) */
	churn: ChurnMap;
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

/** Watchdogs que declaram o arquivo (união dos `classify`). */
export function matchWatchdogs<TId extends string>(
	filePath: string,
	watchdogs: Record<TId, WatchdogDefinition>,
	watchdogIds: readonly TId[],
	content?: string,
	facts?: AstFacts,
): TId[] {
	const ids: TId[] = [];
	for (const id of watchdogIds) {
		if (
			watchdogs[id]?.classify?.some((rule) =>
				matchesClassifyRule(filePath, rule, content, facts),
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

/** Id do watchdog de último recurso (primeiro declarado), se houver. */
export function fallbackWatchdogId<TId extends string>(
	config: HoundsmanConfig<TId>,
): TId | undefined {
	return config.watchdogIds.find((id) => config.watchdogs[id]?.fallback === true);
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
	churn: ChurnMap = {},
	astFacts?: ReadonlyMap<string, AstFacts>,
): ClassificationResult {
	const watchdogFiles: Record<string, string[]> = {};
	const files: ClassificationResult["files"] = {};
	const unclassified: string[] = [];
	const excluded: string[] = [];
	const deleted: string[] = [];
	// Watchdog de último recurso: cobre apenas arquivos sem outro dono.
	const fallbackId = fallbackWatchdogId(config);
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
		const facts = astFacts?.get(path);
		const matched = matchWatchdogs(
			path,
			config.watchdogs,
			config.watchdogIds,
			content,
			facts,
		);
		const ids = fallbackId ? matched.filter((id) => id !== fallbackId) : matched;

		if (ids.length === 0) {
			if (fallbackId) {
				watchdogFiles[fallbackId] ??= [];
				watchdogFiles[fallbackId].push(path);
			} else {
				unclassified.push(path);
			}
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
		churn,
		unclassified,
		excluded,
		deleted,
		stats,
		excludedCount: excluded.length,
	};
}

/**
 * Executa `git diff` entre base e head e classifica os arquivos alterados.
 *
 * `diff` (opcional) reaproveita um `DiffSource` já coletado — evita rodar o git
 * de novo quando o chamador (ex.: `prepare`) precisa também do patch para o Jev.
 */
export function classifyRange<TId extends string>(
	base: string,
	head: string,
	config: HoundsmanConfig<TId>,
	diff?: DiffSource,
	astFacts?: ReadonlyMap<string, AstFacts>,
): ClassificationResult {
	const entries = parseEntries(runGit(["diff", `${base}...${head}`, "--name-status"]));
	const churn = diff?.churn ?? collectChurn(base, head);
	const result = classifyEntries(entries, config, churnToRecord(churn), astFacts);
	result.base = base;
	result.head = head;
	return result;
}

// ---------------------------------------------------------------------------
// Triage (PRs grandes) — reexportado do domínio
// ---------------------------------------------------------------------------

export {
	type BudgetSelection,
	churnOf,
	selectByBudget,
	sortByRisk,
} from "./domain/budget";
