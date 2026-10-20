/**
 * Worktrees gerenciados pelo houndsman (biblioteca).
 *
 * Um worktree por branch revisada, criado em **detached HEAD** no commit da PR.
 * Detached evita o conflito "branch já checada" com o clone principal e é o
 * modo correto para revisão (somente leitura). Vive fora do projeto, em
 * `<baseDir>/<repoSlug>/<branchSlug>`.
 *
 * Os dois segmentos são `<trecho-legível>-<hash8>`: o trecho legível é
 * truncado porque o checkout de uma PR herda a profundidade dos arquivos do
 * projeto, e o Windows (MAX_PATH = 260) estoura "Filename too long" com
 * repo+branch longos. O hash mantém o nome determinístico e único.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGitRunner } from "../git-runner";
import { sanitizeBranch } from "../report-builder";
import { worktreesRoot } from "../storage/paths";
import { GitRepository } from "./git-repository";

/** Entrada de `git worktree list --porcelain`. */
export type WorktreeEntry = {
	path: string;
	head?: string;
	/** Ref completo (`refs/heads/...`) quando não detached. */
	branch?: string;
	detached: boolean;
	bare: boolean;
	prunable: boolean;
	locked: boolean;
};

/** Entrada de criação de worktree. */
export type EnsureWorktreeInput = {
	branch: string;
	/** Ref/SHA que o worktree deve apontar. */
	ref: string;
};

/** Resultado da criação/reuso. */
export type EnsureWorktreeResult = {
	path: string;
	/** Commit efetivamente checado (detached). */
	head: string;
	/** `true` quando o diretório foi criado agora. */
	created: boolean;
	/** `true` quando já existia apontando para o commit pedido. */
	reused: boolean;
};

/** Resultado da remoção. */
export type RemoveWorktreeResult = {
	removed: boolean;
	detail?: string;
};

/** Opções do gerenciador. */
export type WorktreeManagerOptions = {
	repoKey: string;
	/** Raiz do clone principal. */
	repoRoot: string;
	/**
	 * Raiz onde os diretórios por repositório são criados.
	 * Default: `<HOUNDSMAN_HOME>/worktrees` (o CLI normalmente passa
	 * `resolveWorktreesRoot(config.worktrees?.location, repoRoot)`).
	 */
	baseDir?: string;
};

/** Limite do trecho legível no diretório do repositório. */
const REPO_SLUG_MAX = 24;
/** Limite do trecho legível no diretório da branch. */
const BRANCH_SLUG_MAX = 20;

/**
 * `<trecho legível truncado>-<hash8>`: curto o bastante para o MAX_PATH do
 * Windows e estável para o mesmo par (repositório, branch).
 */
function hashName(key: string, readable: string, max: number, fallback: string): string {
	const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
	// Ponto/traço no fim do nome é descartado pelo Windows; corte antes do hash.
	const head = readable.slice(0, max).replace(/[-._]+$/, "");
	return `${head || fallback}-${hash}`;
}

/** Slug estável e legível para o diretório do repositório. */
export function repoSlug(repoKey: string): string {
	const clean = repoKey
		.replace(/^(remote|path):/, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return hashName(repoKey, clean.slice(-REPO_SLUG_MAX), REPO_SLUG_MAX, "repo");
}

/** Slug estável e curto para o diretório de uma branch. */
export function branchSlug(branch: string): string {
	return hashName(branch, sanitizeBranch(branch), BRANCH_SLUG_MAX, "branch");
}

/** Normaliza um path para comparação (Windows é case-insensitive). */
function normalizePath(path: string): string {
	const absolute = resolve(path).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** `true` se `path` está dentro de `root`. */
function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !rel.split(sep).includes(".."));
}

/** Fatia a saída de `git worktree list --porcelain` em entradas. */
export function parseWorktreeList(raw: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;

	const flush = (): void => {
		if (current) entries.push(current);
		current = null;
	};

	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			current = {
				path: line.slice("worktree ".length).trim(),
				detached: false,
				bare: false,
				prunable: false,
				locked: false,
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
		else if (line.startsWith("branch ")) current.branch = line.slice(7).trim();
		else if (line === "detached") current.detached = true;
		else if (line === "bare") current.bare = true;
		else if (line.startsWith("prunable")) current.prunable = true;
		else if (line.startsWith("locked")) current.locked = true;
	}
	flush();
	return entries;
}

/** Gerencia os worktrees de um repositório. */
export class WorktreeManager {
	private readonly git: GitRepository;
	private readonly repoKey: string;
	private readonly rootDir: string;

	constructor(git: GitRepository, options: WorktreeManagerOptions) {
		this.git = git;
		this.repoKey = options.repoKey;
		this.rootDir = join(
			options.baseDir ?? worktreesRoot(),
			repoSlug(options.repoKey),
		);
	}

	/**
	 * Garante o diretório gerenciado e um `.gitignore` local (`*`), para que
	 * worktrees dentro do repositório nunca sujem `git status` — mesmo que a
	 * camada `.houndsman/.gitignore` ainda não tenha sido atualizada.
	 */
	private ensureRoot(): void {
		mkdirSync(this.rootDir, { recursive: true });
		const ignore = join(this.rootDir, ".gitignore");
		if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
	}

	/** Diretório-base dos worktrees deste repositório. */
	get baseDir(): string {
		return this.rootDir;
	}

	/** Caminho determinístico do worktree de uma branch. */
	pathFor(branch: string): string {
		return join(this.rootDir, branchSlug(branch));
	}

	/** Todos os worktrees registrados no repositório. */
	list(): WorktreeEntry[] {
		return parseWorktreeList(this.git.worktreeListRaw());
	}

	/** Apenas os worktrees sob o diretório gerenciado. */
	managed(): WorktreeEntry[] {
		return this.list().filter((entry) => isInside(this.rootDir, entry.path));
	}

	/** Worktree registrado para uma branch (se existir). */
	find(branch: string): WorktreeEntry | null {
		const target = normalizePath(this.pathFor(branch));
		return this.list().find((entry) => normalizePath(entry.path) === target) ?? null;
	}

	/**
	 * Garante o worktree da branch no commit `ref`.
	 *
	 * Reusa quando o HEAD já é o commit pedido; tenta `checkout --detach` quando
	 * existe e está em outro commit; recria quando o diretório está quebrado.
	 */
	ensure(input: EnsureWorktreeInput): EnsureWorktreeResult {
		this.ensureRoot();
		const path = this.pathFor(input.branch);
		const target = this.git.resolveSha(input.ref);
		const existing = this.list().find(
			(entry) => normalizePath(entry.path) === normalizePath(path),
		);

		if (existing) {
			if (existing.head === target) {
				return { path, head: target, created: false, reused: true };
			}
			const checkout = new GitRepository(createGitRunner(path)).tryRun([
				"checkout",
				"--detach",
				target,
			]);
			if (checkout.ok) {
				return { path, head: target, created: false, reused: true };
			}
			// Worktree quebrado/inacessível: remove e recria do zero.
			this.git.removeWorktree(path, true);
			rmSync(path, { recursive: true, force: true });
		} else if (existsSync(path)) {
			// Diretório sobrou de um prune/remoção manual.
			if (!isInside(this.rootDir, path)) {
				throw new Error(`Worktree fora da raiz gerenciada: ${path}`);
			}
			rmSync(path, { recursive: true, force: true });
		}

		mkdirSync(dirname(path), { recursive: true });
		try {
			this.git.addWorktree(path, target);
		} catch (error) {
			// Corrida com outro processo ou metadado órfão: pruna e tenta 1x.
			this.git.pruneWorktrees();
			try {
				this.git.addWorktree(path, target);
			} catch (retry) {
				const detail = retry instanceof Error ? retry.message : String(retry);
				const original = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Falha ao criar worktree em ${path}: ${detail || original}`,
				);
			}
		}
		return { path, head: target, created: true, reused: false };
	}

	/** Remove o worktree de uma branch (ou um path absoluto). */
	remove(
		branchOrPath: string,
		options: { force?: boolean } = {},
	): RemoveWorktreeResult {
		const path = isAbsolute(branchOrPath) ? branchOrPath : this.pathFor(branchOrPath);
		const entry = this.list().find(
			(worktree) => normalizePath(worktree.path) === normalizePath(path),
		);
		if (!entry) {
			if (existsSync(path) && isInside(this.rootDir, path)) {
				rmSync(path, { recursive: true, force: true });
			}
			return { removed: false, detail: "worktree não registrado" };
		}

		const result = this.git.removeWorktree(path, options.force ?? false);
		if (result.ok) return { removed: true };

		if (options.force) {
			rmSync(path, { recursive: true, force: true });
			this.git.pruneWorktrees();
			return { removed: true };
		}
		return { removed: false, detail: result.stderr.trim() };
	}

	/** Limpa metadados de worktrees que não existem mais. */
	prune(): string {
		return this.git.pruneWorktrees().stdout.trim();
	}

	/** Nome legível do repositório gerenciado (diagnóstico). */
	get name(): string {
		return basename(this.rootDir) || this.repoKey;
	}
}
