/**
 * Status do run (biblioteca) — colunas da review no storage.
 *
 * Diz à UI em que pé está uma run: `reviewing` (revisando) → `review_done`
 * (revisão finalizada) → `fixing` (corrigindo) → `fix_done` (correção finalizada).
 *
 * Toda ação que muda o estado faz um **ping** no `updatedAt`. Timeout é
 * **display-only** (a UI compara `updatedAt` com o agora) — não é um status
 * persistido.
 */

import type { FindingsStateFile } from "./findings-state";
import { systemClock } from "./services/clock";
import type { ReviewRecord, ReviewStatus, StorageProvider } from "./storage/types";

/** Estados de execução de uma run (persistidos). */
export type RunStatus = ReviewStatus;

/** Valores canônicos de status (ordem de exibição/lifecycle). */
export const RUN_STATUSES: readonly RunStatus[] = [
	"reviewing",
	"review_done",
	"fixing",
	"fix_done",
];

/** Lê o status atual (null se a review não existir). */
export function readRunStatus(
	storage: StorageProvider,
	reviewId: string,
): ReviewRecord | null {
	return storage.getReview(reviewId);
}

export type WriteRunStatusOptions = {
	status: RunStatus;
	/** Reinicia o `startedAt` — usado no início de uma nova revisão. */
	resetStartedAt?: boolean;
	now?: string;
};

/** Grava/atualiza o status da review (ping no `updatedAt`). */
export function writeRunStatus(
	storage: StorageProvider,
	reviewId: string,
	options: WriteRunStatusOptions,
): ReviewRecord {
	const updated = storage.updateReview(reviewId, {
		status: options.status,
		resetStartedAt: options.resetStartedAt,
		updatedAt: options.now ?? systemClock(),
	});
	if (!updated) throw new Error(`Review '${reviewId}' não encontrada.`);
	return updated;
}

/**
 * Deriva o status após uma mudança nos findings (triagem/correção).
 * `fixing` exige correção em andamento (`in_progress`) ou retomada de um fix;
 * `fix_done` quando o fix começou e a fila (`execute` não `done`) esvaziou.
 */
export function statusAfterFindingsChange(
	previous: RunStatus | null,
	state: FindingsStateFile,
): RunStatus {
	const findings = Object.values(state.findings);
	const active = findings.filter((finding) => finding.present);

	if (active.some((finding) => finding.execState === "in_progress")) return "fixing";

	const queueRemaining = active.some(
		(finding) => finding.decision === "execute" && finding.execState !== "done",
	);
	const anyDone = active.some(
		(finding) => finding.decision === "execute" && finding.execState === "done",
	);
	const fixStarted = previous === "fixing" || previous === "fix_done" || anyDone;
	if (fixStarted) return queueRemaining ? "fixing" : "fix_done";

	return previous ?? "review_done";
}

/** Ping: deriva o status da mudança nos findings e grava na review. */
export function pingFindingsStatus(
	storage: StorageProvider,
	reviewId: string,
	state: FindingsStateFile,
): ReviewRecord {
	const previous = storage.getReview(reviewId)?.status ?? null;
	return writeRunStatus(storage, reviewId, {
		status: statusAfterFindingsChange(previous, state),
	});
}
