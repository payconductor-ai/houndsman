/**
 * Helpers compartilhados pelas tools built-in (leitura, grep e snippets).
 *
 * Tudo é read-only e passa pelo `PathGuard`; nada executa shell arbitrário.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runGit } from "../../../core/git-runner";
import type { PathGuard } from "../path-guard";
import { limitLines, limitText, numberLines, TOOL_LIMITS } from "../result-limiter";

/** Linhas de um arquivo; `null` se ilegível. */
export function readLines(path: string): string[] | null {
	try {
		return readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
	} catch {
		return null;
	}
}

/** Trecho numerado de um arquivo (1-based, inclusivo). */
export function numberedRange(
	lines: readonly string[],
	startLine: number,
	endLine: number,
): string {
	const start = Math.max(1, startLine);
	const end = Math.min(lines.length, Math.max(start, endLine));
	const slice = lines.slice(start - 1, end);
	return numberLines(start, slice);
}

/** Snippet bruto (sem numeração), limitado em linhas. */
export function snippet(
	lines: readonly string[],
	startLine: number,
	endLine: number,
): string {
	const start = Math.max(1, startLine);
	const end = Math.min(lines.length, Math.max(start, endLine));
	const limited = limitLines(lines.slice(start - 1, end), TOOL_LIMITS.maxSnippetLines);
	return limitText(limited.lines.join("\n")).text;
}

/** Executa `git grep` na raiz do repositório. */
export function gitGrep(
	root: string,
	args: string[],
): { ok: boolean; stdout: string; stderr: string } {
	try {
		const stdout = runGit(["-C", root, "grep", ...args]);
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Caminho relativo normalizado. */
export function relativeTo(root: string, path: string): string {
	return relative(root, path).replace(/\\/g, "/");
}

/** Lê uma faixa validada (PathGuard + limites). */
export function readRange(
	guard: PathGuard,
	path: string,
	startLine: number,
	endLine: number,
): {
	path: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	content: string;
	truncated: boolean;
} | null {
	const absolute = guard.assertReadable(path);
	const lines = readLines(absolute);
	if (!lines) return null;
	const start = Math.max(1, startLine);
	const requestedEnd = Math.max(start, endLine);
	const cappedEnd = Math.min(
		requestedEnd,
		start + TOOL_LIMITS.maxLines - 1,
		lines.length,
	);
	const limited = limitText(
		numberLines(start, lines.slice(start - 1, cappedEnd)),
		TOOL_LIMITS.maxBytes,
	);
	return {
		path: relativeTo(guard.root, absolute),
		startLine: start,
		endLine: cappedEnd,
		totalLines: lines.length,
		content: limited.text,
		truncated: limited.truncated || cappedEnd < requestedEnd,
	};
}

/** Parseia uma linha `arquivo:linha:conteúdo` do `git grep -n`. */
export function parseGrepLine(
	line: string,
): { file: string; line: number; text: string } | null {
	const match = /^(.+?):(\d+):(.*)$/.exec(line);
	if (!match) return null;
	const [, file, number, text] = match;
	if (!file || !number) return null;
	return { file, line: Number.parseInt(number, 10), text: text ?? "" };
}
