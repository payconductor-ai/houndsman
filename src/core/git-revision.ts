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

import { DEFAULT_MAX_PER_FILE_CHARS, type DiffSource } from "./diff-source";
import { parseEntries } from "./file-classifier";
import { runGit } from "./git-runner";
import { GitRepository } from "./services/git-repository";
import type { FileChurn } from "./types";

export { runGit };

/** Repositório padrão (runner real) usado pelos helpers funcionais. */
const git = new GitRepository();

/** SHA completo de uma ref (`git rev-parse`). Lança se a ref não resolver. */
export function resolveSha(ref: string): string {
	return git.resolveSha(ref);
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
	return git.isAncestor(ancestor, descendant);
}

/** Conteúdo de um arquivo num commit (`git show sha:path`); null se ausente. */
export function readFileAt(sha: string, path: string): string | null {
	return git.readFileAt(sha, path);
}

/** Arquivos alterados num intervalo (`git diff range --name-status`). */
export function diffEntries(range: string): ReturnType<typeof parseEntries> {
	return parseEntries(git.run(["diff", range, "--name-status"]));
}

/** Churn por arquivo de um intervalo (`git diff --numstat -z range`). */
export function diffNumstat(range: string): Map<string, FileChurn> {
	return git.diffNumstat(range);
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
	return git.diffPatch(range, paths, maxPerFileChars);
}

/** Diff (patch + churn) de `from..to` — 2 spawns, base do review incremental. */
export function collectDiffSince(
	from: string,
	to: string,
	maxPerFileChars: number = DEFAULT_MAX_PER_FILE_CHARS,
): DiffSource {
	return git.collectDiffSince(from, to, maxPerFileChars);
}
