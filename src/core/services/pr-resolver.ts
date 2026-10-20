/**
 * Resolução de uma PR para revisão (biblioteca).
 *
 * Usa `gh pr view` para descobrir head/base e garante os commits localmente.
 * O head é buscado em `refs/pull/<n>/head`, que funciona também para forks;
 * o base vem de `origin/<baseRefName>`. Fail-open na leitura, mas a revisão só
 * começa quando as refs necessárias existem (erro explícito caso contrário).
 */

import { describeGhError, type GhRunner } from "./gh-client";
import type { GitRepository } from "./git-repository";

const PR_FIELDS =
	"number,title,headRefName,baseRefName,headRefOid,isCrossRepository,url,isDraft";

/** Dados mínimos de uma PR para montar o worktree. */
export type PullRequestInfo = {
	number: number;
	title?: string;
	headRefName: string;
	baseRefName: string;
	/** Commit exato do head no momento da consulta. */
	headSha?: string;
	isCrossRepository: boolean;
	isDraft: boolean;
	url?: string;
};

/** Resultado da consulta ao `gh`. */
export type PrResolveResult =
	| { ok: true; pr: PullRequestInfo }
	| { ok: false; reason: "gh" | "invalid"; detail: string };

/** Refs locais preparadas para o diff. */
export type PrRefs = {
	base: string;
	head: string;
	/** `true` quando o fetch trouxe algo novo. */
	fetched: boolean;
	/** Aviso (ex.: fetch parcial) para o CLI imprimir. */
	warning?: string;
};

type GhPrView = {
	number?: unknown;
	title?: unknown;
	headRefName?: unknown;
	baseRefName?: unknown;
	headRefOid?: unknown;
	isCrossRepository?: unknown;
	isDraft?: unknown;
	url?: unknown;
};

/** Cliente de PR sobre um runner injetável. */
export class PrResolver {
	constructor(
		private readonly runner: GhRunner,
		private readonly git: GitRepository,
	) {}

	/** Consulta a PR no GitHub (nunca lança). */
	resolve(number: number): PrResolveResult {
		const result = this.runner(["pr", "view", String(number), "--json", PR_FIELDS]);
		if (!result.ok) {
			return { ok: false, reason: "gh", detail: describeGhError(result) };
		}

		let parsed: GhPrView;
		try {
			parsed = JSON.parse(result.stdout) as GhPrView;
		} catch {
			return {
				ok: false,
				reason: "invalid",
				detail: "Resposta inválida do gh (JSON malformado).",
			};
		}

		const headRefName =
			typeof parsed.headRefName === "string" ? parsed.headRefName.trim() : "";
		const baseRefName =
			typeof parsed.baseRefName === "string" ? parsed.baseRefName.trim() : "";
		const resolvedNumber = Number(parsed.number);
		if (
			!Number.isFinite(resolvedNumber) ||
			resolvedNumber <= 0 ||
			headRefName.length === 0 ||
			baseRefName.length === 0
		) {
			return {
				ok: false,
				reason: "invalid",
				detail: "gh não devolveu número/head/base da PR.",
			};
		}

		return {
			ok: true,
			pr: {
				number: resolvedNumber,
				title: typeof parsed.title === "string" ? parsed.title : undefined,
				headRefName,
				baseRefName,
				headSha:
					typeof parsed.headRefOid === "string"
						? parsed.headRefOid.trim()
						: undefined,
				isCrossRepository: Boolean(parsed.isCrossRepository),
				isDraft: Boolean(parsed.isDraft),
				url: typeof parsed.url === "string" ? parsed.url : undefined,
			},
		};
	}

	/**
	 * Garante base/head da PR no repositório local.
	 *
	 * Prefere o SHA informado pelo `gh`; cai para `refs/houndsman/pr-<n>` quando
	 * o objeto não existe localmente.
	 */
	prepareRefs(pr: PullRequestInfo): PrRefs {
		const headRef = `refs/houndsman/pr-${pr.number}`;
		const headFetch = this.git.fetch("origin", [
			`+refs/pull/${pr.number}/head:${headRef}`,
		]);
		const baseFetch = this.git.fetch("origin", [pr.baseRefName]);

		const originBase = `origin/${pr.baseRefName}`;
		const hasOriginBase = this.git.tryRun(["rev-parse", "--verify", originBase]).ok;
		const base = hasOriginBase ? originBase : pr.baseRefName;

		const hasSha = pr.headSha
			? this.git.tryRun(["cat-file", "-e", `${pr.headSha}^{commit}`]).ok
			: false;
		const head = hasSha && pr.headSha ? pr.headSha : headRef;

		const warning =
			!headFetch.ok && !hasSha
				? `Não foi possível buscar o head da PR: ${headFetch.stderr.trim()}`
				: !baseFetch.ok
					? `Não foi possível atualizar ${pr.baseRefName}: ${baseFetch.stderr.trim()}`
					: undefined;

		return { base, head, fetched: headFetch.ok || baseFetch.ok, warning };
	}
}
