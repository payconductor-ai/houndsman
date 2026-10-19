/**
 * Comentários de uma Pull Request (servidor) — threads de revisão + comentários
 * gerais, lidos via `gh api`.
 *
 * A aba é lazy: só chama o GitHub quando o cliente pede. O resultado fica em
 * cache por branch (TTL de 60s); `refresh` ignora o cache. Tudo fail-open: sem
 * PR/gh/login, devolve `available:false` e a UI mostra o motivo.
 */

import { resolve } from "node:path";
import { resolvePrTarget } from "../core/github-review";
import { systemClock } from "../core/services/clock";
import { describeGhError, type GhRunner } from "../core/services/gh-client";

/** Cache do payload já processado (por raiz do repositório + branch). */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: PrCommentsResponse }>();

/** Limpa o cache (testes e shutdown). */
export function clearPrCommentsCache(): void {
	cache.clear();
}

/** Comentário já normalizado para a UI. */
export type PrCommentView = {
	id: number;
	author: string;
	authorType: string;
	body: string;
	createdAt?: string;
	url?: string;
	path?: string;
	line: number | null;
	absFile?: string;
	replyTo?: number | null;
};

/** Thread de revisão (comentário raiz + respostas). */
export type PrCommentThread = {
	id: number;
	path: string;
	line: number | null;
	absFile: string;
	comments: PrCommentView[];
};

/** Resposta de `GET /api/runs/:slug/comments`. */
export type PrCommentsResponse = {
	available: boolean;
	reason?: string;
	target?: { number: number; repo: string; url?: string };
	fetchedAt: string;
	threads: PrCommentThread[];
	issueComments: PrCommentView[];
	counts: { threads: number; inline: number; issue: number };
};

type GhInlineComment = {
	id?: number;
	body?: string;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	created_at?: string;
	html_url?: string;
	in_reply_to_id?: number | null;
	user?: { login?: string; type?: string };
};

type GhIssueComment = {
	id?: number;
	body?: string;
	created_at?: string;
	html_url?: string;
	user?: { login?: string; type?: string };
};

type ApiList = { ok: true; items: unknown[] } | { ok: false; reason: string };

function unavailable(
	reason: string,
	target?: PrCommentsResponse["target"],
): PrCommentsResponse {
	return {
		available: false,
		reason,
		target,
		fetchedAt: systemClock(),
		threads: [],
		issueComments: [],
		counts: { threads: 0, inline: 0, issue: 0 },
	};
}

/** Lista paginada via `gh api`; `--slurp` junta as páginas num único array. */
function ghApiList(runner: GhRunner, path: string): ApiList {
	let result = runner(["api", "--paginate", "--slurp", path]);
	if (!result.ok && /unknown flag|unknown shorthand|slurp/i.test(result.stderr)) {
		result = runner(["api", path]);
	}
	if (!result.ok) return { ok: false, reason: describeGhError(result) };
	try {
		const parsed = JSON.parse(result.stdout);
		if (Array.isArray(parsed)) {
			// Dependendo da versão do gh, `--slurp` pode devolver `[[...], [...]]`
			// (um array por página) ou um array já achatado.
			const items: unknown[] = [];
			for (const item of parsed) {
				if (Array.isArray(item)) items.push(...item);
				else items.push(item);
			}
			return { ok: true, items };
		}
		return { ok: false, reason: "Resposta inesperada do gh (esperava uma lista)." };
	} catch {
		return { ok: false, reason: "Resposta inválida do gh (JSON malformado)." };
	}
}

function toView(
	raw: GhInlineComment | GhIssueComment,
	repoRoot: string,
): PrCommentView | null {
	const id = Number(raw.id);
	const body = raw.body?.trim() ?? "";
	if (!Number.isFinite(id) || body.length === 0) return null;
	const path = "path" in raw ? raw.path : undefined;
	const line = "line" in raw ? (raw.line ?? raw.original_line ?? null) : null;
	return {
		id,
		author: raw.user?.login ?? "desconhecido",
		authorType: raw.user?.type ?? "User",
		body,
		createdAt: raw.created_at,
		url: raw.html_url,
		path,
		line,
		absFile: path ? resolve(repoRoot, path) : undefined,
		replyTo: "in_reply_to_id" in raw ? (raw.in_reply_to_id ?? null) : null,
	};
}

/** Agrupa comentários inline em threads (raiz + respostas). */
function buildThreads(
	items: unknown[],
	repoRoot: string,
): {
	threads: PrCommentThread[];
	inline: number;
} {
	const raws = (items as GhInlineComment[])
		.filter((raw) => raw && typeof raw === "object")
		.sort(
			(a, b) =>
				(a.created_at ?? "").localeCompare(b.created_at ?? "") ||
				Number(a.id ?? 0) - Number(b.id ?? 0),
		);

	const views: PrCommentView[] = [];
	const parent = new Map<number, number | null>();
	for (const raw of raws) {
		const view = toView(raw, repoRoot);
		if (!view) continue;
		views.push(view);
		parent.set(view.id, raw.in_reply_to_id ?? null);
	}

	const rootOf = (id: number): number => {
		let current = id;
		const seen = new Set<number>();
		for (;;) {
			const next = parent.get(current);
			if (!next || seen.has(current)) return current;
			seen.add(current);
			current = next;
		}
	};

	const byRoot = new Map<number, PrCommentThread>();
	for (const view of views) {
		const rootId = rootOf(view.id);
		const existing = byRoot.get(rootId);
		if (existing) {
			existing.comments.push(view);
			continue;
		}
		const path = view.path ?? "";
		byRoot.set(rootId, {
			id: rootId,
			path,
			line: view.line,
			absFile: view.absFile ?? (path ? resolve(repoRoot, path) : ""),
			comments: [view],
		});
	}

	const threads = [...byRoot.values()].sort(
		(a, b) =>
			a.path.localeCompare(b.path) ||
			(a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
			a.id - b.id,
	);
	return { threads, inline: views.length };
}

/** Lê e agrupa os comentários da PR da branch (com cache de 60s). */
export function fetchPrComments(options: {
	runner: GhRunner;
	branch: string;
	repoRoot: string;
	refresh?: boolean;
	now?: number;
}): PrCommentsResponse {
	const { runner, branch, repoRoot, refresh = false } = options;
	const now = options.now ?? Date.now();
	const key = `${resolve(repoRoot)}\0${branch}`;
	const cached = cache.get(key);
	if (!refresh && cached && cached.expiresAt > now) return cached.value;

	const target = resolvePrTarget(runner, branch);
	if (!target.ok) return unavailable(target.reason);

	const pr = {
		number: target.target.number,
		repo: target.target.repo,
		url: target.target.url,
	};
	const inline = ghApiList(runner, `repos/${pr.repo}/pulls/${pr.number}/comments`);
	if (!inline.ok) return unavailable(inline.reason, pr);

	const issue = ghApiList(runner, `repos/${pr.repo}/issues/${pr.number}/comments`);
	if (!issue.ok) return unavailable(issue.reason, pr);

	const { threads, inline: inlineCount } = buildThreads(inline.items, repoRoot);
	const issueComments = (issue.items as GhIssueComment[])
		.map((raw) => toView(raw, repoRoot))
		.filter((view): view is PrCommentView => view !== null)
		.sort(
			(a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id,
		);

	const value: PrCommentsResponse = {
		available: true,
		target: pr,
		fetchedAt: systemClock(),
		threads,
		issueComments,
		counts: {
			threads: threads.length,
			inline: inlineCount,
			issue: issueComments.length,
		},
	};
	cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
	return value;
}
