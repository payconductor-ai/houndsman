/**
 * Repositório das runs (servidor) — leitura/escrita via storage.
 *
 * Escopa tudo ao repositório do cwd: a UI mostra só as runs do projeto atual.
 * O slug continua sendo o branch-slug (estável nas URLs).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	applyFindingUpdate,
	emptyState,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsFilter,
	type FindingsStateFile,
	type FindingsSummary,
	type FindingUpdate,
	fileReader,
	filterFindings,
	reorder,
	resolveFindingId,
	type SyncResult,
	summarize,
	syncState,
} from "../core/findings-state";
import {
	buildSubmitPreview,
	type GhRunner,
	resolvePrTarget,
	type SubmitSelection,
	submitFindings,
	syncResolvedThreads,
} from "../core/github-review";
import { pingFindingsStatus } from "../core/run-status";
import { systemClock } from "../core/services/clock";
import { defaultGhRunner } from "../core/services/gh-client";
import type { WorktreeManager } from "../core/services/worktree-manager";
import { workRoot } from "../core/storage/paths";
import type { RepoIdentity, ReviewRecord, StorageProvider } from "../core/storage/types";
import { ReviewWorkArea } from "../core/storage/work-area";
import type { Severity } from "../core/types";
import { isSlug } from "./artifacts";
import { fetchPrComments, type PrCommentsResponse } from "./pr-comments";

/** Item da lista de execuções (sidebar) — já ordenado do mais recente ao antigo. */
export type RunListItem = {
	slug: string;
	branch: string;
	/** Variante A/B (ausente = run principal da branch). */
	variant?: string;
	/** Worktree onde a run foi executada (ausente = clone principal). */
	worktreePath?: string;
	/** PR revisada (quando iniciada via `--pr`). */
	prNumber?: number;
	updatedAt?: string;
	startedAt?: string;
	heartbeatAt?: string;
	status: ReviewRecord["status"];
	summary: FindingsSummary;
};

/** Detalhe de uma run (cabeçalho da UI). */
export type RunDetail = {
	slug: string;
	branch: string;
	/** Variante A/B (ausente = run principal da branch). */
	variant?: string;
	/** Worktree onde a run foi executada (ausente = clone principal). */
	worktreePath?: string;
	/** PR revisada (quando iniciada via `--pr`). */
	prNumber?: number;
	status: ReviewRecord | null;
	manifest: unknown;
	summary: FindingsSummary;
	watchdogs: string[];
	unclassified: string[];
	deleted: string[];
};

/** Resultado da exclusão de uma run. */
export type DeleteRunResult = {
	deleted: boolean;
	/** O usuário pediu para remover o worktree. */
	worktreeRequested: boolean;
	/** O worktree foi de fato removido. */
	worktreeRemoved: boolean;
	worktreePath?: string;
	/** Aviso quando o worktree não pôde ser removido. */
	warning?: string;
};

/** Resultado do envio dos findings à PR. */
export type SubmitResult =
	| { available: false; reason: string }
	| { available: true; target: unknown; outcome: unknown };

/** Metadados de um artefato (sem conteúdo) para a lista da UI. */
export type ArtifactListItem = {
	name: string;
	kind: string;
	contentType: string;
	updatedAt: string;
};

/** Acesso às runs de um repositório. */
export class RunRepository {
	private readonly storage: StorageProvider;
	private readonly repo: RepoIdentity;
	private readonly ghRunner: GhRunner;
	private readonly worktrees?: WorktreeManager;

	constructor(
		storage: StorageProvider,
		repo: RepoIdentity,
		ghRunner: GhRunner = defaultGhRunner,
		worktrees?: WorktreeManager,
	) {
		this.storage = storage;
		this.repo = repo;
		this.ghRunner = ghRunner;
		this.worktrees = worktrees;
	}

	/** `true` se o slug aponta para uma run do repositório atual. */
	exists(slug: string): boolean {
		return this.findBySlug(slug) !== null;
	}

	/** Lista as runs com resumo (mais recentes primeiro). */
	list(): RunListItem[] {
		return this.storage.listReviews(this.repo.key).map((review) => {
			const state = this.storage.readFindings(review.id);
			return {
				variant: review.variant,
				slug: review.slug,
				branch: review.branch,
				worktreePath: review.worktreePath,
				prNumber: review.prNumber,
				updatedAt: review.updatedAt,
				startedAt: review.startedAt,
				heartbeatAt: review.heartbeatAt,
				status: review.status,
				summary: summarize(state ?? emptyState(review.branch)),
			};
		});
	}

	/** Mapa branch → slug das runs (usado para casar PRs com execuções). */
	branchIndex(): Map<string, string> {
		const index = new Map<string, string>();
		for (const review of this.reviewsForBranchLinks()) {
			if (!index.has(review.branch)) index.set(review.branch, review.slug);
		}
		return index;
	}

	/** Mapa branch → run + worktree (sidebar de PRs). */
	workspaceIndex(): Map<
		string,
		{ slug: string; worktreePath?: string; prNumber?: number }
	> {
		const index = new Map<
			string,
			{ slug: string; worktreePath?: string; prNumber?: number }
		>();
		for (const review of this.reviewsForBranchLinks()) {
			if (index.has(review.branch)) continue;
			index.set(review.branch, {
				slug: review.slug,
				worktreePath: review.worktreePath,
				prNumber: review.prNumber,
			});
		}
		return index;
	}

	/**
	 * Runs ordenadas para links de PR: a principal da branch primeiro (uma
	 * variante A/B não deve "roubar" o atalho da PR), depois as mais recentes.
	 */
	private reviewsForBranchLinks(): ReviewRecord[] {
		return [...this.storage.listReviews(this.repo.key)].sort(
			(a, b) =>
				Number(Boolean(a.variant)) - Number(Boolean(b.variant)) ||
				b.updatedAt.localeCompare(a.updatedAt),
		);
	}

	/** Detalhe da run (null se o slug for inválido). */
	detail(slug: string): RunDetail | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const classification = this.readArtifactJson<{
			watchdogs?: Record<string, string[]>;
			unclassified?: string[];
			deleted?: string[];
		}>(review, "classification.json");
		return {
			slug: review.slug,
			variant: review.variant,
			branch: review.branch,
			worktreePath: review.worktreePath,
			prNumber: review.prNumber,
			status: review,
			manifest: this.readArtifactJson(review, "manifest.json"),
			summary: summarize(state),
			watchdogs: Object.keys(classification?.watchdogs ?? {}),
			unclassified: classification?.unclassified ?? [],
			deleted: classification?.deleted ?? [],
		};
	}

	/**
	 * Apaga a run por completo: staging local, findings, histórico, artefatos e a
	 * review. Opcionalmente remove o worktree (com `--force`, pois a run foi
	 * confirmada para exclusão).
	 */
	delete(
		slug: string,
		options: { removeWorktree?: boolean } = {},
	): DeleteRunResult | null {
		const review = this.findBySlug(slug);
		if (!review) return null;

		const worktreePath = review.worktreePath;
		const removeWorktree = options.removeWorktree === true && Boolean(worktreePath);
		let worktreeRemoved = false;
		let warning: string | undefined;

		if (removeWorktree && worktreePath) {
			if (this.worktrees) {
				const result = this.worktrees.remove(worktreePath, { force: true });
				worktreeRemoved = result.removed;
				if (!result.removed) {
					warning = result.detail ?? "worktree não removido";
				}
			} else {
				warning = "worktree não gerenciado por este servidor";
			}
		}

		// Staging atual (dentro do worktree quando existe) + legado no home.
		new ReviewWorkArea(review).clean();
		new ReviewWorkArea(review, workRoot()).clean();

		this.storage.deleteReview(review.id);
		return {
			deleted: true,
			worktreeRequested: options.removeWorktree === true,
			worktreeRemoved,
			worktreePath,
			warning,
		};
	}

	/** Aplica `VACUUM`/`optimize` no backend (chamado no start do server). */
	maintain(): void {
		this.storage.maintain();
	}

	/** Fecha o provider (shutdown do server). */
	dispose(): void {
		this.storage.close();
	}

	// -----------------------------------------------------------------------
	// Internos
	// -----------------------------------------------------------------------

	private findBySlug(slug: string): ReviewRecord | null {
		if (!isSlug(slug)) return null;
		return (
			this.storage
				.listReviews(this.repo.key)
				.find((review) => review.slug === slug) ?? null
		);
	}

	private loadState(review: ReviewRecord): FindingsStateFile {
		return this.storage.readFindings(review.id) ?? emptyState(review.branch);
	}

	/** Raiz dos arquivos da review: worktree vivo ou clone principal. */
	private rootOf(review: ReviewRecord): string {
		const worktree = review.worktreePath;
		return worktree && existsSync(worktree) ? worktree : this.repo.root;
	}

	private readArtifactJson<T>(review: ReviewRecord, name: string): T | null {
		const artifact = this.storage.readArtifact(review.id, name);
		if (!artifact) return null;
		try {
			return JSON.parse(artifact.content) as T;
		} catch {
			return null;
		}
	}

	/** Findings filtrados + resumo (null se o slug for inválido). */
	findings(
		slug: string,
		params: URLSearchParams,
	): {
		branch: string;
		findings: (FindingState & { absFile: string })[];
		summary: FindingsSummary;
	} | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const filter: FindingsFilter = {
			decision: (params.get("decision") as FindingDecision) || undefined,
			execState: (params.get("exec") as FindingExecState) || undefined,
			severity: (params.get("severity") as Severity) || undefined,
			watchdog: params.get("watchdog") || undefined,
			file: params.get("file") || undefined,
			includeAbsent: params.get("all") === "1",
		};
		return {
			branch: review.branch,
			findings: filterFindings(state, filter).map((finding) =>
				toClientFinding(finding, review),
			),
			summary: summarize(state),
		};
	}

	/** Um finding (null se ausente/inválido). Aceita prefixo único do id. */
	finding(slug: string, id: string): (FindingState & { absFile: string }) | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const resolution = resolveFindingId(state, id);
		if (resolution.status !== "found") return null;
		return toClientFinding(state.findings[resolution.id], review);
	}

	/** Aplica uma atualização a um finding (null se ausente/inválido). */
	update(
		slug: string,
		id: string,
		body: FindingUpdate,
	): (FindingState & { absFile: string }) | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const resolution = resolveFindingId(state, id);
		if (resolution.status !== "found") return null;
		const finding = state.findings[resolution.id];
		applyFindingUpdate(finding, body);
		// "Done" na UI é resolução local: resolve a conversa no PR (fail-open).
		if (body.execState === "done") {
			syncResolvedThreads({ state, ids: [finding.id] });
		}
		reorder(state);
		state.updatedAt = systemClock();
		this.storage.writeFindings(review.id, state);
		pingFindingsStatus(this.storage, review.id, state);
		return toClientFinding(finding, review);
	}

	/** Reancora os findings contra os arquivos atuais. */
	sync(slug: string): {
		result: SyncResult;
		summary: FindingsSummary;
	} | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const result = syncState(state, fileReader(this.rootOf(review)));
		this.storage.writeFindings(review.id, state);
		pingFindingsStatus(this.storage, review.id, state);
		return { result, summary: summarize(state) };
	}

	/** Prévia do envio da revisão (candidatos + disponibilidade da PR). */
	submitPreview(slug: string, runner: GhRunner): unknown | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const target = resolvePrTarget(runner, review.branch);
		return buildSubmitPreview(state, target);
	}

	/** Envia os findings selecionados à PR (fail-open). */
	submit(
		slug: string,
		selection: SubmitSelection,
		runner: GhRunner,
	): SubmitResult | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		const state = this.loadState(review);
		const target = resolvePrTarget(runner, review.branch);
		if (!target.ok) return { available: false, reason: target.reason };

		const outcome = submitFindings({
			state,
			target: target.target,
			runner,
			selection,
		});
		this.storage.writeFindings(review.id, state);
		pingFindingsStatus(this.storage, review.id, state);
		return { available: true, target: target.target, outcome };
	}

	/** Comentários da PR da run (null se o slug for inválido). */
	comments(
		slug: string,
		options: { refresh?: boolean } = {},
	): PrCommentsResponse | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		return fetchPrComments({
			runner: this.ghRunner,
			branch: review.branch,
			repoRoot: review.repoRoot,
			refresh: options.refresh,
		});
	}

	/** Lista os artefatos da run (sem conteúdo). */
	artifacts(slug: string): ArtifactListItem[] | null {
		const review = this.findBySlug(slug);
		if (!review) return null;
		return this.storage.listArtifacts(review.id).map((artifact) => ({
			name: artifact.name,
			kind: artifact.kind,
			contentType: artifact.contentType,
			updatedAt: artifact.updatedAt,
		}));
	}

	/** Conteúdo de um artefato (`json`/`md`) da run (null se não servível). */
	artifact(slug: string, name: string): { content: string; type: string } | null {
		if (!/\.(json|md)$/i.test(name)) return null;
		const review = this.findBySlug(slug);
		if (!review) return null;
		const artifact = this.storage.readArtifact(review.id, name);
		if (!artifact) return null;
		return { content: artifact.content, type: artifact.contentType };
	}
}

/**
 * Finding + caminho absoluto. O cliente monta o link `vscode://file/...` e não
 * conhece o cwd do servidor — o caminho relativo do relatório não basta.
 */
function toClientFinding(
	finding: FindingState,
	review: ReviewRecord,
): FindingState & { absFile: string } {
	const root =
		review.worktreePath && existsSync(review.worktreePath)
			? review.worktreePath
			: review.repoRoot;
	return { ...finding, absFile: resolve(root, finding.file) };
}
