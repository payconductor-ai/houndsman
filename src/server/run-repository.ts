/**
 * Repositório das runs (servidor) — leitura/escrita via storage.
 *
 * Escopa tudo ao repositório do cwd: a UI mostra só as runs do projeto atual.
 * O slug continua sendo o branch-slug (estável nas URLs).
 */

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
} from "../core/github-review";
import { pingFindingsStatus } from "../core/run-status";
import { systemClock } from "../core/services/clock";
import type { RepoIdentity, ReviewRecord, StorageProvider } from "../core/storage/types";
import type { Severity } from "../core/types";
import { isSlug } from "./artifacts";

/** Item da lista de execuções (sidebar) — já ordenado do mais recente ao antigo. */
export type RunListItem = {
	slug: string;
	branch: string;
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
	status: ReviewRecord | null;
	manifest: unknown;
	summary: FindingsSummary;
	watchdogs: string[];
	unclassified: string[];
	deleted: string[];
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

	constructor(storage: StorageProvider, repo: RepoIdentity) {
		this.storage = storage;
		this.repo = repo;
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
				slug: review.slug,
				branch: review.branch,
				updatedAt: review.updatedAt,
				startedAt: review.startedAt,
				heartbeatAt: review.heartbeatAt,
				status: review.status,
				summary: summarize(state ?? emptyState(review.branch)),
			};
		});
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
			branch: review.branch,
			status: review,
			manifest: this.readArtifactJson(review, "manifest.json"),
			summary: summarize(state),
			watchdogs: Object.keys(classification?.watchdogs ?? {}),
			unclassified: classification?.unclassified ?? [],
			deleted: classification?.deleted ?? [],
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
		const result = syncState(state, fileReader(process.cwd()));
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
	return { ...finding, absFile: resolve(review.repoRoot, finding.file) };
}
