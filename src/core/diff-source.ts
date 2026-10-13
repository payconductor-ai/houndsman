/**
 * Coleta do diff em um único passo (biblioteca).
 *
 * Roda `git diff base...head` **uma vez** (patch) e `--numstat` **uma vez**
 * (churn), fatiando o patch por arquivo em memória — o custo não cresce com o
 * número de arquivos da PR.
 *
 * Usado por `orchestrator.prepare` (churn para a classificação + patch para o
 * Jev) e por `classifyRange` (fallback standalone).
 */

import type { ChurnMap, FileChurn } from "./types";

export type DiffSource = {
	/** path → patch do arquivo (header + hunks), truncado por `maxPerFileChars`. */
	byFile: Map<string, string>;
	/** path (novo) → linhas adicionadas/removidas. */
	churn: Map<string, FileChurn>;
};

export type CollectDiffOptions = {
	/** Teto de caracteres por arquivo no patch (default: 8_000). */
	maxPerFileChars?: number;
};

const DEFAULT_MAX_PER_FILE_CHARS = 8_000;

/** Executa `git` com `core.quotepath=false` (paths literais) e devolve o stdout. */
function runGit(args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "core.quotepath=false", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`git ${args.join(" ")} falhou: ${stderr}`);
	}
	return new TextDecoder().decode(result.stdout);
}

/** Novo caminho do arquivo a partir do cabeçalho de um segmento do patch. */
function extractPath(segment: string): string | undefined {
	// Só o cabeçalho (antes do primeiro hunk) pode conter as linhas `---`/`+++` —
	// assim uma linha de conteúdo como `+++ b/x` não é confundida com o header.
	const hunkAt = segment.indexOf("\n@@");
	const header = hunkAt >= 0 ? segment.slice(0, hunkAt) : segment;
	const lines = header.split("\n");

	for (const line of lines) {
		if (line.startsWith("+++ b/")) return line.slice(6);
	}
	for (const line of lines) {
		// Deletados têm `+++ /dev/null`; o caminho antigo é a melhor referência.
		if (line.startsWith("--- a/")) return line.slice(6);
	}

	// Fallback (ex.: binário, sem `---`/`+++`): `a/<old> b/<new>`.
	const firstLine = lines[0] ?? "";
	const marker = firstLine.lastIndexOf(" b/");
	return marker >= 0 ? firstLine.slice(marker + 3) : undefined;
}

/** Fatia um patch unificado por arquivo (`diff --git`). */
export function parseDiffIndex(
	patch: string,
	maxPerFileChars = Number.POSITIVE_INFINITY,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const segment of patch.split(/^diff --git /m)) {
		if (!segment.trim()) continue;
		const path = extractPath(segment);
		if (!path) continue;
		const text = `diff --git ${segment}`;
		map.set(
			path,
			text.length > maxPerFileChars ? text.slice(0, maxPerFileChars) : text,
		);
	}
	return map;
}

/** Contagem do `--numstat` (`-` em binários) → número. */
function toCount(value: string): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** Fatia `git diff --numstat -z` em path → churn (trata renames/cópias/bins). */
export function parseNumstat(raw: string): Map<string, FileChurn> {
	const map = new Map<string, FileChurn>();
	const tokens = raw.split("\0");

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		const fields = token.split("\t");
		if (fields.length < 3) continue;

		let path = fields[2];
		if (path === "") {
			// Renomeado/copiado: os dois caminhos seguem como tokens próprios.
			path = tokens[i + 2] ?? "";
			i += 2;
		}
		if (!path) continue;

		map.set(path, { additions: toCount(fields[0]), deletions: toCount(fields[1]) });
	}
	return map;
}

/** Churn por arquivo (`git diff --numstat -z`) — 1 spawn. */
export function collectChurn(base: string, head: string): Map<string, FileChurn> {
	return parseNumstat(runGit(["diff", "--numstat", "-z", `${base}...${head}`]));
}

/**
 * Patch + churn em uma passada: 2 spawns fixos, independentes do nº de arquivos.
 */
export function collectDiff(
	base: string,
	head: string,
	options: CollectDiffOptions = {},
): DiffSource {
	const range = `${base}...${head}`;
	const patch = runGit(["diff", range]);
	return {
		byFile: parseDiffIndex(
			patch,
			options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS,
		),
		churn: collectChurn(base, head),
	};
}

/** Converte o Map de churn em Record (para o `classification.json`). */
export function churnToRecord(churn: Map<string, FileChurn>): ChurnMap {
	return Object.fromEntries(churn);
}
