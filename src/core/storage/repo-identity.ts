/**
 * Identidade do repositório (biblioteca).
 *
 * A UI e o CLI escopam runs por repositório. Preferimos o remote `origin`
 * normalizado (`github.com/org/repo`) porque a pasta local pode ser movida;
 * sem remote, caímos no caminho absoluto da raiz git.
 */

import { resolve } from "node:path";
import { GitRepository } from "../services/git-repository";
import type { RepoIdentity } from "./types";

/** Normaliza um remote para `host/owner/repo` (sem protocolo, credencial ou `.git`). */
export function normalizeRemote(raw: string): string | null {
	const value = raw.trim().replace(/\/+$/, "");
	if (value.length === 0) return null;

	// SCP-like: `git@github.com:owner/repo.git`.
	if (!value.includes("://")) {
		const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
		if (scp) return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2])}`;
		// Caminho local — não é um remote utilizável para identidade.
		return null;
	}

	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const path = stripGitSuffix(url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
		return path.length > 0 ? `${host}/${path}` : host;
	} catch {
		return null;
	}
}

function stripGitSuffix(value: string): string {
	return value.replace(/\.git$/i, "").replace(/^\/+/, "");
}

/** Normaliza a raiz local para comparação (Windows é case-insensitive). */
function normalizeRoot(root: string): string {
	const normalized = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Monta a identidade a partir do remote cru e da raiz do repositório. */
export function buildRepoIdentity(
	remote: string | null | undefined,
	root: string,
): RepoIdentity {
	const normalized = remote ? normalizeRemote(remote) : null;
	const absoluteRoot = resolve(root);
	if (normalized) {
		return {
			key: `remote:${normalized}`,
			root: absoluteRoot,
			remote: remote ?? undefined,
		};
	}
	return { key: `path:${normalizeRoot(absoluteRoot)}`, root: absoluteRoot };
}

/** Resolve a identidade do repositório a partir do cwd (nunca lança). */
export function resolveRepoIdentity(
	git: GitRepository = new GitRepository(),
	cwd: string = process.cwd(),
): RepoIdentity {
	const root = git.rootPath() ?? resolve(cwd);
	return buildRepoIdentity(git.remoteUrl(), root);
}
