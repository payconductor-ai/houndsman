/**
 * Acesso ao repositório git (biblioteca) — superfície OO sobre `git-runner`.
 *
 * Centraliza resolução de refs, ancestralidade, leitura por commit e coleta de
 * diffs. Nenhum path/id de consumidor aqui.
 */

import {
	type CollectDiffOptions,
	DEFAULT_MAX_PER_FILE_CHARS,
	type DiffSource,
	parseDiffIndex,
	parseNumstat,
} from "../diff-source";
import {
	defaultGitRunner,
	type GitResult,
	type GitRunner,
	runGit,
	tryGit,
} from "../git-runner";
import type { FileChurn } from "../types";

/** Repositório git com runner injetável (testes). */
export class GitRepository {
	private readonly runner: GitRunner;

	constructor(runner: GitRunner = defaultGitRunner) {
		this.runner = runner;
	}

	/** Executa git e devolve stdout; lança em falha. */
	run(args: string[]): string {
		return runGit(args, this.runner);
	}

	/** Executa git sem lançar (sondagens). */
	tryRun(args: string[]): GitResult {
		return tryGit(args, this.runner);
	}

	/** SHA completo de uma ref. */
	resolveSha(ref: string): string {
		return this.run(["rev-parse", ref]).trim();
	}

	/** Branch atual; `null` se indisponível (sem git, detached ou erro). */
	currentBranch(): string | null {
		const result = this.tryRun(["branch", "--show-current"]);
		if (!result.ok) return null;
		const branch = result.stdout.trim();
		return branch.length > 0 ? branch : null;
	}

	/** Raiz do repositório; `null` fora de um repo git. */
	rootPath(): string | null {
		const result = this.tryRun(["rev-parse", "--show-toplevel"]);
		if (!result.ok) return null;
		const root = result.stdout.trim();
		return root.length > 0 ? root : null;
	}

	/** URL de um remote (default `origin`); `null` se ausente. */
	remoteUrl(name = "origin"): string | null {
		const result = this.tryRun(["remote", "get-url", name]);
		if (!result.ok) return null;
		const url = result.stdout.trim();
		return url.length > 0 ? url : null;
	}

	/**
	 * `true` se `ancestor` é ancestral de `descendant`. Qualquer outro desfecho
	 * (ref desconhecida, exit ≠ 0) devolve `false` — cai no review completo.
	 */
	isAncestor(ancestor: string, descendant: string): boolean {
		return this.tryRun(["merge-base", "--is-ancestor", ancestor, descendant]).ok;
	}
	/** SHA do merge-base entre duas refs; `null` quando não há ancestral comum. */
	mergeBase(base: string, head: string): string | null {
		const result = this.tryRun(["merge-base", base, head]);
		const sha = result.ok ? result.stdout.trim() : "";
		return sha.length > 0 ? sha : null;
	}

	/**
	 * Diretório git comum (`.git`) em caminho absoluto. Em um worktree linkado
	 * aponta para o `.git` do clone principal — é como descobrimos a raiz real.
	 */
	gitCommonDir(): string | null {
		const result = this.tryRun([
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		const dir = result.ok ? result.stdout.trim() : "";
		return dir.length > 0 ? dir : null;
	}

	/** Saída crua de `git worktree list --porcelain` (vazia em erro). */
	worktreeListRaw(): string {
		const result = this.tryRun(["worktree", "list", "--porcelain"]);
		return result.ok ? result.stdout : "";
	}

	/** Cria um worktree detached apontando para `ref` (lança em falha). */
	addWorktree(path: string, ref: string): string {
		return this.run(["worktree", "add", "--detach", path, ref]);
	}

	/** Remove um worktree; nunca lança (devolve o resultado para o chamador). */
	removeWorktree(path: string, force = false): GitResult {
		return this.tryRun(["worktree", "remove", ...(force ? ["--force"] : []), path]);
	}

	/** Remove metadados de worktrees cujo diretório sumiu. */
	pruneWorktrees(): GitResult {
		return this.tryRun(["worktree", "prune"]);
	}

	/** `git fetch --no-tags <remote> <refspecs...>` (nunca lança). */
	fetch(remote: string, refspecs: readonly string[]): GitResult {
		return this.tryRun(["fetch", "--no-tags", remote, ...refspecs]);
	}

	/** Conteúdo de um arquivo num commit; `null` se ausente. */
	readFileAt(sha: string, path: string): string | null {
		const result = this.tryRun(["show", `${sha}:${path}`]);
		return result.ok ? result.stdout : null;
	}

	/** `git diff base...head --name-status` cru. */
	diffNameStatus(base: string, head: string): string {
		return this.run(["diff", `${base}...${head}`, "--name-status"]);
	}

	/** Churn por arquivo de um intervalo (`--numstat -z`). */
	diffNumstat(range: string): Map<string, FileChurn> {
		return parseNumstat(this.run(["diff", "--numstat", "-z", range]));
	}

	/** Patch por arquivo de um intervalo, opcionalmente restrito a `paths`. */
	diffPatch(
		range: string,
		paths?: readonly string[],
		maxPerFileChars: number = DEFAULT_MAX_PER_FILE_CHARS,
	): Map<string, string> {
		const args = ["diff", range];
		if (paths && paths.length > 0) args.push("--", ...paths);
		return parseDiffIndex(this.run(args), maxPerFileChars);
	}

	/** Churn de `base...head` — 1 spawn. */
	collectChurn(base: string, head: string): Map<string, FileChurn> {
		return this.diffNumstat(`${base}...${head}`);
	}

	/** Patch + churn da PR (`base...head`) — 2 spawns fixos. */
	collectDiff(
		base: string,
		head: string,
		options: CollectDiffOptions = {},
	): DiffSource {
		const range = `${base}...${head}`;
		return {
			byFile: parseDiffIndex(
				this.run(["diff", range]),
				options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS,
			),
			churn: this.collectChurn(base, head),
		};
	}

	/** Patch + churn de `from..to` — base do review incremental. */
	collectDiffSince(
		from: string,
		to: string,
		maxPerFileChars: number = DEFAULT_MAX_PER_FILE_CHARS,
	): DiffSource {
		const range = `${from}..${to}`;
		return {
			byFile: parseDiffIndex(this.run(["diff", range]), maxPerFileChars),
			churn: this.diffNumstat(range),
		};
	}
}
