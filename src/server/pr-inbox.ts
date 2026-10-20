/**
 * Caixa de entrada de Pull Requests do repositório atual (servidor).
 *
 * Lista as PRs abertas via `gh` e executa o checkout somente quando a árvore
 * de trabalho está limpa. Fail-open: sem `gh` (ou sem git), devolve o motivo e
 * a UI degrada sem quebrar as demais abas.
 */

import { describeGhError, type GhRunner } from "../core/services/gh-client";
import type { GitRepository } from "../core/services/git-repository";

/** Estado da árvore de trabalho (base do bloqueio do checkout). */
export type WorktreeState = {
	/** `false` quando o `git status` falhou. */
	available: boolean;
	clean: boolean;
	changes: number;
	/** Amostra dos caminhos alterados (limitada para a UI). */
	sample: string[];
};

/** Run associada à branch de uma PR. */
export type PrRunInfo = {
	slug: string;
	worktreePath?: string;
	prNumber?: number;
};

/** PR aberta exibida na sidebar. */
export type PrListItem = {
	number: number;
	title: string;
	headRefName: string;
	baseRefName: string;
	author: string;
	updatedAt?: string;
	isDraft: boolean;
	reviewDecision?: string;
	url?: string;
	/** Run local correspondente à branch, quando existir. */
	runSlug?: string;
	/** Worktree ativo da PR (revisão paralela). */
	worktreePath?: string;
};

/** Resposta de `GET /api/prs`. */
export type PrListResponse = {
	available: boolean;
	reason?: string;
	currentBranch: string | null;
	worktree: WorktreeState;
	prs: PrListItem[];
};

/** Resultado do checkout de uma PR. */
export type CheckoutResponse =
	| { ok: true; number: number; branch: string | null }
	| {
			ok: false;
			reason: "dirty" | "git" | "gh";
			detail: string;
			changes?: string[];
	  };

const PR_LIST_FIELDS =
	"number,title,headRefName,baseRefName,author,updatedAt,isDraft,reviewDecision,url";

type GhPrListItem = {
	number?: number;
	title?: string;
	headRefName?: string;
	baseRefName?: string;
	author?: { login?: string; name?: string };
	updatedAt?: string;
	isDraft?: boolean;
	reviewDecision?: string;
	url?: string;
};

function toItem(
	raw: GhPrListItem,
	runs: ReadonlyMap<string, PrRunInfo>,
): PrListItem | null {
	const number = Number(raw.number);
	const headRefName = raw.headRefName?.trim();
	if (!Number.isFinite(number) || number <= 0 || !headRefName) return null;
	const run = runs.get(headRefName);
	return {
		number,
		title: raw.title?.trim() || `PR #${number}`,
		headRefName,
		baseRefName: raw.baseRefName?.trim() || "",
		author: raw.author?.login ?? raw.author?.name ?? "desconhecido",
		updatedAt: raw.updatedAt,
		isDraft: Boolean(raw.isDraft),
		reviewDecision: raw.reviewDecision?.trim() || undefined,
		url: raw.url,
		runSlug: run?.slug,
		worktreePath: run?.worktreePath,
	};
}

/** Acesso às PRs do repositório atual. */
export class PrInbox {
	constructor(
		private readonly ghRunner: GhRunner,
		private readonly git: GitRepository,
	) {}

	/** Estado da árvore de trabalho (`git status --porcelain`). */
	worktree(): WorktreeState {
		const result = this.git.tryRun(["status", "--porcelain"]);
		if (!result.ok) {
			return { available: false, clean: false, changes: 0, sample: [] };
		}
		const lines = result.stdout
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		return {
			available: true,
			clean: lines.length === 0,
			changes: lines.length,
			sample: lines.slice(0, 20),
		};
	}

	/** Lista as PRs abertas (limite 50) e o estado local do repositório. */
	list(runs: ReadonlyMap<string, PrRunInfo> = new Map()): PrListResponse {
		const currentBranch = this.git.currentBranch();
		const worktree = this.worktree();
		const result = this.ghRunner([
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			"50",
			"--json",
			PR_LIST_FIELDS,
		]);

		if (!result.ok) {
			return {
				available: false,
				reason: describeGhError(result),
				currentBranch,
				worktree,
				prs: [],
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			return {
				available: false,
				reason: "Resposta inválida do gh (JSON malformado).",
				currentBranch,
				worktree,
				prs: [],
			};
		}
		if (!Array.isArray(parsed)) {
			return {
				available: false,
				reason: "Resposta inesperada do gh (esperava uma lista de PRs).",
				currentBranch,
				worktree,
				prs: [],
			};
		}

		const prs = (parsed as GhPrListItem[])
			.map((item) => toItem(item, runs))
			.filter((item): item is PrListItem => item !== null)
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

		return { available: true, currentBranch, worktree, prs };
	}

	/**
	 * Faz checkout da PR via `gh pr checkout`.
	 *
	 * A árvore precisa estar limpa: alterações locais não commitadas bloqueiam a
	 * operação para não descartar trabalho do usuário.
	 */
	checkout(number: number): CheckoutResponse {
		const worktree = this.worktree();
		if (!worktree.available) {
			return {
				ok: false,
				reason: "git",
				detail: "Não foi possível ler o estado do git.",
			};
		}
		if (!worktree.clean) {
			return {
				ok: false,
				reason: "dirty",
				detail: `${worktree.changes} alteração(ões) não commitada(s).`,
				changes: worktree.sample,
			};
		}

		const result = this.ghRunner(["pr", "checkout", String(number)]);
		if (!result.ok) {
			return { ok: false, reason: "gh", detail: describeGhError(result) };
		}
		return { ok: true, number, branch: this.git.currentBranch() };
	}
}
