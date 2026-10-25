/**
 * Status da run (biblioteca) — leitura e heartbeat para a UI.
 *
 * `status ping` é o sinal de vida de uma skill em execução (revisão ou
 * correção). O heartbeat é separado de `updatedAt`: triagem/sync atualizam o
 * segundo, mas não fingem que existe uma execução em andamento.
 */

import { currentBranch } from "../pr-context";
import { type RunStatus, touchRunStatus } from "../run-status";
import type { RepoIdentity, ReviewRecord, StorageProvider } from "../storage/types";

export type StatusResult = {
	branch: string;
	status: RunStatus | null;
	startedAt?: string;
	heartbeatAt?: string;
	updatedAt: string;
};

function toResult(review: ReviewRecord): StatusResult {
	return {
		branch: review.branch,
		status: review.status,
		startedAt: review.startedAt,
		heartbeatAt: review.heartbeatAt,
		updatedAt: review.updatedAt,
	};
}

/** Resolve a review da branch (explícita ou a atual do git). */
function findReview(
	storage: StorageProvider,
	repo: RepoIdentity,
	branch?: string,
	variant?: string,
): ReviewRecord {
	const target = branch ?? currentBranch();
	const review = storage.findReview(repo.key, target, variant);
	if (!review) {
		throw new Error(
			`Nenhuma revisão para '${target}'${variant ? ` (variante '${variant}')` : ""}.`,
		);
	}
	return review;
}

/** Lê o status atual da run. */
export function readStatus(
	storage: StorageProvider,
	repo: RepoIdentity,
	branch?: string,
	variant?: string,
): StatusResult {
	return toResult(findReview(storage, repo, branch, variant));
}

/** Renova o heartbeat de uma execução ativa (`reviewing`/`fixing`). */
export function pingStatus(
	storage: StorageProvider,
	repo: RepoIdentity,
	branch?: string,
	variant?: string,
	now?: string,
): StatusResult {
	const review = findReview(storage, repo, branch, variant);
	return toResult(touchRunStatus(storage, review.id, now));
}
