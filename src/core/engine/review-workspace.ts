/**
 * Resolução do workspace de uma revisão (engine).
 *
 * Decide onde a revisão roda: clone principal, worktree explícito (`--worktree`)
 * ou worktree criado/reusado para uma PR (`--pr`). Devolve a raiz operacional,
 * a raiz do clone principal (identidade/config) e as refs do diff.
 */

import { basename, dirname, resolve } from "node:path";
import { createGitRunner } from "../git-runner";
import { createGhRunner, type GhRunner } from "../services/gh-client";
import { GitRepository } from "../services/git-repository";
import { PrResolver } from "../services/pr-resolver";
import { syncProjectLayer, WorktreeManager } from "../services/worktree-manager";
import { resolveWorktreesRoot } from "../storage/paths";
import { resolveRepoIdentity } from "../storage/repo-identity";
import type { RepoIdentity } from "../storage/types";

/** Pedido de resolução (flags do CLI). */
export type WorkspaceRequest = {
	cwd: string;
	base: string;
	head: string;
	branch?: string;
	/** Número da PR (`--pr`). */
	pr?: number;
	/** Worktree já existente (`--worktree`). */
	worktree?: string;
};

/** Dependências injetáveis (testes). */
export type WorkspaceDeps = {
	ghRunner?: GhRunner;
	/** `config.worktrees.location` (default: `workspace`). */
	worktreesLocation?: string;
	/** Override explícito da raiz de worktrees (testes). */
	worktreesRoot?: string;
};

/** Workspace resolvido para a revisão. */
export type ResolvedWorkspace = {
	/** Onde os arquivos e o git da revisão são lidos. */
	root: string;
	/** Clone principal (identidade estável + camada/config). */
	mainRoot: string;
	repo: RepoIdentity;
	git: GitRepository;
	branch: string;
	base: string;
	head: string;
	prNumber?: number;
	worktreePath?: string;
	/** Avisos para o CLI (fetch parcial, reuso etc.). */
	messages: string[];
};

/**
 * Raiz do clone principal a partir de um worktree linkado.
 * `--git-common-dir` aponta para `<main>/.git`; qualquer outro formato usa `fallback`.
 */
export function mainRootOf(git: GitRepository, fallback: string): string {
	const common = git.gitCommonDir();
	if (!common) return fallback;
	const normalized = common.replace(/[\\/]+$/, "");
	return basename(normalized).toLowerCase() === ".git" ? dirname(normalized) : fallback;
}

/** Cria um repositório git enraizado em `root`. */
function repoAt(root: string): GitRepository {
	return new GitRepository(createGitRunner(root));
}

/** Compara paths levando em conta o filesystem (Windows é case-insensitive). */
function samePath(a: string, b: string): boolean {
	const norm = (path: string): string => {
		const absolute = resolve(path).replace(/[\\/]+$/, "");
		return process.platform === "win32" ? absolute.toLowerCase() : absolute;
	};
	return norm(a) === norm(b);
}

/** Resolve o workspace efetivo da revisão. */
export function resolveReviewWorkspace(
	request: WorkspaceRequest,
	deps: WorkspaceDeps = {},
): ResolvedWorkspace {
	const messages: string[] = [];
	const cwdGit = repoAt(request.cwd);
	const cwdRoot = resolve(cwdGit.rootPath() ?? request.cwd);
	const mainRoot = resolve(mainRootOf(cwdGit, cwdRoot));
	const mainGit = repoAt(mainRoot);

	// Worktree explícito: a revisão roda onde o usuário mandou.
	if (request.worktree) {
		const path = resolve(request.cwd, request.worktree);
		const git = repoAt(path);
		const root = git.rootPath();
		if (!root) {
			throw new Error(`'${path}' não é um worktree/repositório git válido.`);
		}
		const repo = resolveRepoIdentity(git, root);
		const branch = request.branch ?? git.currentBranch();
		if (!branch) {
			throw new Error(
				`Worktree '${root}' está em detached HEAD. Informe --branch <nome>.`,
			);
		}
		// A camada gerada não vem no checkout; sem ela os comandos no worktree
		// não carregam a config (`../core/types`).
		const explicitMainRoot = mainRootOf(git, repo.root);
		syncProjectLayer(explicitMainRoot, root);
		return {
			root,
			mainRoot: explicitMainRoot,
			repo,
			git,
			branch,
			base: request.base,
			head: request.head,
			worktreePath: root,
			messages,
		};
	}

	// PR: cria/reusa o worktree detached no commit da PR.
	if (request.pr !== undefined) {
		const repo = resolveRepoIdentity(mainGit, mainRoot);
		const resolver = new PrResolver(
			deps.ghRunner ?? createGhRunner(mainRoot),
			mainGit,
		);
		const resolved = resolver.resolve(request.pr);
		if (!resolved.ok) {
			throw new Error(
				`Não foi possível resolver a PR #${request.pr}: ${resolved.detail}`,
			);
		}
		const { pr } = resolved;
		const refs = resolver.prepareRefs(pr);
		if (refs.warning) messages.push(`GitHub: ${refs.warning}`);

		const manager = new WorktreeManager(mainGit, {
			repoKey: repo.key,
			repoRoot: mainRoot,
			baseDir:
				deps.worktreesRoot ??
				resolveWorktreesRoot(deps.worktreesLocation, mainRoot),
		});
		const worktree = manager.ensure({ branch: pr.headRefName, ref: refs.head });
		const worktreePath = resolve(worktree.path);
		messages.push(
			`Worktree ${worktree.created ? "criado" : "reutilizado"}: ${worktreePath}`,
			`PR #${pr.number} — ${pr.headRefName} → ${pr.baseRefName} @ ${refs.head.slice(0, 7)}.`,
		);

		return {
			root: worktreePath,
			mainRoot,
			repo,
			git: repoAt(worktreePath),
			branch: pr.headRefName,
			base: refs.base,
			head: refs.head,
			prNumber: pr.number,
			worktreePath,
			messages,
		};
	}

	// Já estamos dentro de um worktree: ele é a raiz operacional.
	const repo = resolveRepoIdentity(mainGit, mainRoot);
	if (!samePath(cwdRoot, mainRoot)) {
		const branch = request.branch ?? cwdGit.currentBranch();
		if (!branch) {
			throw new Error(
				`Worktree '${cwdRoot}' está em detached HEAD. Informe --branch <nome>.`,
			);
		}
		messages.push(`Usando o worktree atual: ${cwdRoot}`);
		return {
			root: cwdRoot,
			mainRoot,
			repo,
			git: cwdGit,
			branch,
			base: request.base,
			head: request.head,
			worktreePath: cwdRoot,
			messages,
		};
	}

	// Clone principal.
	const branch = request.branch ?? mainGit.currentBranch();
	if (!branch) {
		throw new Error("Não foi possível detectar a branch. Use --branch <nome>.");
	}
	return {
		root: mainRoot,
		mainRoot,
		repo,
		git: mainGit,
		branch,
		base: request.base,
		head: request.head,
		messages,
	};
}
