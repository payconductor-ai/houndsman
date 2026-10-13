/**
 * Operações de revisão do git (biblioteca).
 *
 * Resolução de refs, ancestralidade, leitura de arquivo por commit e diffs por
 * intervalo (`from..to`) — a base do **review incremental** e da **verificação
 * de findings**, que comparam contra um commit fixado (ex.: o `headSha` da
 * última revisão) em vez do working tree.
 *
 * Genérico: nenhum path/id de consumidor aqui. Reusa os parsers de diff de
 * `diff-source.ts` (`parseDiffIndex`/`parseNumstat`) e de `file-classifier.ts`
 * (`parseEntries`) — não reimplementa leitura de diff.
 */

import {
	DEFAULT_MAX_PER_FILE_CHARS,
	type DiffSource,
	parseDiffIndex,
	parseNumstat,
} from "./diff-source";
import { parseEntries } from "./file-classifier";
import type { FileChurn } from "./types";

/** Executa `git` (paths literais) e devolve o stdout; lança se falhar. */
export function runGit(args: string[]): string {
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

/** SHA completo de uma ref (`git rev-parse`). Lança se a ref não resolver. */
export function resolveSha(ref: string): string {
	return runGit(["rev-parse", ref]).trim();
}

/** SHA do commit atual (`HEAD`). */
export function currentHeadSha(): string {
	return resolveSha("HEAD");
}

/**
 * `true` se `ancestor` é ancestral de `descendant` — histórico linear/sem
 * rebase, condição para o review incremental. Qualquer outro desfecho (ref
 * desconhecida, exit ≠ 0) devolve `false`: cai no review completo, que é o
 * comportamento seguro.
 */
export function isAncestor(ancestor: string, descendant: string): boolean {
	const result = Bun.spawnSync(
		["git", "merge-base", "--is-ancestor", ancestor, descendant],
		{ stdout: "ignore", stderr: "ignore" },
	);
	return result.exitCode === 0;
}

/** Conteúdo de um arquivo num commit (`git show sha:path`); null se ausente. */
export function readFileAt(sha: string, path: string): string | null {
	const result = Bun.spawnSync(
		["git", "-c", "core.quotepath=false", "show", `${sha}:${path}`],
		{ stdout: "pipe", stderr: "ignore" },
	);
	if (result.exitCode !== 0) return null;
	return new TextDecoder().decode(result.stdout);
}

/** Arquivos alterados num intervalo (`git diff range --name-status`). */
export function diffEntries(range: string): ReturnType<typeof parseEntries> {
	return parseEntries(runGit(["diff", range, "--name-status"]));
}

/** Churn por arquivo de um intervalo (`git diff --numstat -z range`). */
export function diffNumstat(range: string): Map<string, FileChurn> {
	return parseNumstat(runGit(["diff", "--numstat", "-z", range]));
}

/**
 * Patch por arquivo de um intervalo, opcionalmente restrito a `paths`.
 * `maxPerFileChars` trunca cada arquivo (default: mesmo teto do `collectDiff`).
 */
export function diffPatch(
	range: string,
	paths?: readonly string[],
	maxPerFileChars: number = DEFAULT_MAX_PER_FILE_CHARS,
): Map<string, string> {
	const args = ["diff", range];
	if (paths && paths.length > 0) args.push("--", ...paths);
	return parseDiffIndex(runGit(args), maxPerFileChars);
}

/** Diff (patch + churn) de `from..to` — 2 spawns, base do review incremental. */
export function collectDiffSince(
	from: string,
	to: string,
	maxPerFileChars: number = DEFAULT_MAX_PER_FILE_CHARS,
): DiffSource {
	const range = `${from}..${to}`;
	return {
		byFile: parseDiffIndex(runGit(["diff", range]), maxPerFileChars),
		churn: diffNumstat(range),
	};
}
