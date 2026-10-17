/**
 * Mapeamento row ↔ domínio do storage SQLite.
 *
 * O banco guarda `short_id` (id curto exibido no CLI) e um `id` UUID como PK.
 * O domínio continua usando `FindingState.id` = short id.
 */

import type { FindingAnchor } from "../../finding-anchor";
import type {
	FindingDecision,
	FindingExecState,
	FindingHistoryEntry,
	FindingState,
	GitHubLink,
} from "../../findings-state";
import type { Severity } from "../../types";
import type { ArtifactKind, ArtifactRecord, ReviewRecord } from "../types";

export type ReviewRow = {
	id: string;
	repo_key: string;
	repo_root: string;
	repo_remote: string | null;
	branch: string;
	slug: string;
	base: string | null;
	head: string | null;
	head_sha: string | null;
	reviewed_sha: string | null;
	reviewed_at: string | null;
	status: string | null;
	started_at: string | null;
	heartbeat_at: string | null;
	created_at: string;
	updated_at: string;
};

export type FindingRow = {
	id: string;
	review_id: string;
	short_id: string;
	fingerprint: string;
	watchdog_ids: string;
	rule: string;
	severity: string;
	file: string;
	line: number | null;
	message: string;
	action: string;
	evidence: string | null;
	anchor: string | null;
	found_at_sha: string | null;
	count: number;
	present: number;
	decision: string;
	comment: string | null;
	exec_state: string;
	github: string | null;
	created_at: string;
	updated_at: string;
};

export type HistoryRow = {
	id: string;
	finding_id: string;
	at: string;
	decision: string;
	exec_state: string;
	comment: string | null;
	by: string | null;
};

export type ArtifactRow = {
	id: string;
	review_id: string;
	name: string;
	kind: string;
	content: string;
	content_type: string;
	created_at: string;
	updated_at: string;
};

/** Converte a row de review no DTO do contrato. */
export function reviewFromRow(row: ReviewRow): ReviewRecord {
	return {
		id: row.id,
		repoKey: row.repo_key,
		repoRoot: row.repo_root,
		repoRemote: row.repo_remote ?? undefined,
		branch: row.branch,
		slug: row.slug,
		base: row.base ?? undefined,
		head: row.head ?? undefined,
		headSha: row.head_sha ?? undefined,
		reviewedSha: row.reviewed_sha ?? undefined,
		reviewedAt: row.reviewed_at ?? undefined,
		status: (row.status as ReviewRecord["status"]) ?? null,
		startedAt: row.started_at ?? undefined,
		heartbeatAt: row.heartbeat_at ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseJson<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Converte a row de finding (+ histórico) no DTO do domínio. */
export function findingFromRow(row: FindingRow, history: HistoryRow[]): FindingState {
	return {
		id: row.short_id,
		fingerprint: row.fingerprint,
		watchdogIds: parseJson<string[]>(row.watchdog_ids) ?? [],
		rule: row.rule,
		severity: row.severity as Severity,
		file: row.file,
		line: row.line === null ? null : Number(row.line),
		message: row.message,
		action: row.action,
		evidence: row.evidence ?? undefined,
		anchor: parseJson<FindingAnchor>(row.anchor) ?? null,
		foundAtSha: row.found_at_sha ?? undefined,
		count: Number(row.count),
		present: row.present === 1,
		decision: row.decision as FindingDecision,
		comment: row.comment ?? undefined,
		execState: row.exec_state as FindingExecState,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		history: history.map((entry) => ({
			at: entry.at,
			decision: entry.decision as FindingDecision,
			execState: entry.exec_state as FindingExecState,
			comment: entry.comment ?? undefined,
			by: entry.by ?? undefined,
		})),
		github: parseJson<GitHubLink>(row.github),
	};
}

/** Converte a row de artefato no DTO do contrato. */
export function artifactFromRow(row: ArtifactRow): ArtifactRecord {
	return {
		id: row.id,
		reviewId: row.review_id,
		name: row.name,
		kind: row.kind as ArtifactKind,
		content: row.content,
		contentType: row.content_type,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export type { FindingHistoryEntry };
