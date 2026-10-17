/**
 * Provider SQLite do houndsman (biblioteca) — implementação principal.
 *
 * Sync (`bun:sqlite`), WAL e escrita transacional do estado de triagem. O
 * staging de briefs/findings fica fora do banco (`storage/work-area.ts`); aqui
 * vivem reviews, findings e artefatos.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, type FindingsStateFile, reorder } from "../../findings-state";
import { systemClock } from "../../services/clock";
import type {
	ArtifactRecord,
	CreateReviewInput,
	ReviewPatch,
	ReviewRecord,
	StorageProvider,
	WriteArtifactInput,
} from "../types";
import {
	type ArtifactRow,
	artifactFromRow,
	type FindingRow,
	findingFromRow,
	type HistoryRow,
	type ReviewRow,
	reviewFromRow,
} from "./mappers";
import { migrate } from "./schema";

/** Colunas mutáveis de review (camel → snake). */
const REVIEW_PATCH_COLUMNS: Record<
	Exclude<keyof ReviewPatch, "resetStartedAt" | "resetHeartbeat">,
	string
> = {
	branch: "branch",
	slug: "slug",
	base: "base",
	head: "head",
	headSha: "head_sha",
	reviewedSha: "reviewed_sha",
	reviewedAt: "reviewed_at",
	status: "status",
	startedAt: "started_at",
	heartbeatAt: "heartbeat_at",
	updatedAt: "updated_at",
};

/** Provider SQLite (arquivo ou `:memory:`). */
export class SQLiteStorageProvider implements StorageProvider {
	readonly kind = "sqlite" as const;
	private readonly db: Database;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		migrate(this.db, path);
	}

	// -----------------------------------------------------------------------
	// Reviews
	// -----------------------------------------------------------------------

	getOrCreateReview(input: CreateReviewInput): ReviewRecord {
		const existing = this.findReview(input.repo.key, input.branch);
		if (existing) {
			// O repo pode ter sido movido; a identidade continua a mesma.
			if (
				existing.repoRoot !== input.repo.root ||
				existing.repoRemote !== input.repo.remote
			) {
				this.db.run(
					"UPDATE reviews SET repo_root = ?, repo_remote = ? WHERE id = ?",
					[input.repo.root, input.repo.remote ?? null, existing.id],
				);
			}
			return this.requireReview(existing.id);
		}

		const now = input.now ?? systemClock();
		const record: ReviewRecord = {
			id: randomUUID(),
			repoKey: input.repo.key,
			repoRoot: input.repo.root,
			repoRemote: input.repo.remote,
			branch: input.branch,
			slug: input.slug,
			base: input.base,
			head: input.head,
			status: null,
			createdAt: now,
			updatedAt: now,
		};
		this.db.run(
			`INSERT INTO reviews
				(id, repo_key, repo_root, repo_remote, branch, slug, base, head,
				 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				record.id,
				record.repoKey,
				record.repoRoot,
				record.repoRemote ?? null,
				record.branch,
				record.slug,
				record.base ?? null,
				record.head ?? null,
				record.createdAt,
				record.updatedAt,
			],
		);
		return record;
	}

	findReview(repoKey: string, branch: string): ReviewRecord | null {
		const row = this.db
			.query("SELECT * FROM reviews WHERE repo_key = ? AND branch = ?")
			.get(repoKey, branch) as ReviewRow | null;
		return row ? reviewFromRow(row) : null;
	}

	getReview(id: string): ReviewRecord | null {
		const row = this.db
			.query("SELECT * FROM reviews WHERE id = ?")
			.get(id) as ReviewRow | null;
		return row ? reviewFromRow(row) : null;
	}

	listReviews(repoKey?: string): ReviewRecord[] {
		const rows = (
			repoKey
				? this.db
						.query(
							"SELECT * FROM reviews WHERE repo_key = ? ORDER BY updated_at DESC",
						)
						.all(repoKey)
				: this.db.query("SELECT * FROM reviews ORDER BY updated_at DESC").all()
		) as ReviewRow[];
		return rows.map(reviewFromRow);
	}

	updateReview(id: string, patch: ReviewPatch): ReviewRecord | null {
		if (!this.getReview(id)) return null;
		const now = patch.updatedAt ?? systemClock();
		const sets: string[] = [];
		const params: (string | number | null)[] = [];

		for (const [key, column] of Object.entries(REVIEW_PATCH_COLUMNS)) {
			const value = patch[key as keyof ReviewPatch];
			if (value === undefined) continue;
			sets.push(`${column} = ?`);
			params.push(value as string | number | null);
		}
		if (patch.resetStartedAt) {
			sets.push("started_at = ?");
			params.push(now);
		}
		if (patch.resetHeartbeat) {
			sets.push("heartbeat_at = NULL");
		}
		if (patch.updatedAt === undefined) {
			sets.push("updated_at = ?");
			params.push(now);
		}

		if (sets.length > 0) {
			params.push(id);
			this.db.run(`UPDATE reviews SET ${sets.join(", ")} WHERE id = ?`, params);
		}
		return this.getReview(id);
	}

	deleteReview(id: string): void {
		this.db.run("DELETE FROM reviews WHERE id = ?", [id]);
	}

	// -----------------------------------------------------------------------
	// Findings
	// -----------------------------------------------------------------------

	readFindings(reviewId: string): FindingsStateFile | null {
		const review = this.getReview(reviewId);
		if (!review) return null;

		const rows = this.db
			.query("SELECT * FROM findings WHERE review_id = ? ORDER BY rowid")
			.all(reviewId) as FindingRow[];
		if (
			rows.length === 0 &&
			(review.status === null || review.status === "reviewing")
		) {
			return null;
		}

		const historyStmt = this.db.query(
			"SELECT * FROM finding_history WHERE finding_id = ? ORDER BY rowid",
		);
		const findings: FindingsStateFile["findings"] = {};
		for (const row of rows) {
			findings[row.short_id] = findingFromRow(
				row,
				historyStmt.all(row.id) as HistoryRow[],
			);
		}

		const base = emptyState(review.branch);
		const state: FindingsStateFile = {
			...base,
			slug: review.slug,
			updatedAt: review.updatedAt,
			reviewed: review.reviewedSha
				? {
						headSha: review.reviewedSha,
						at: review.reviewedAt ?? review.updatedAt,
					}
				: undefined,
			findings,
		};
		reorder(state);
		return state;
	}

	writeFindings(reviewId: string, state: FindingsStateFile): void {
		if (!this.getReview(reviewId)) {
			throw new Error(`Review '${reviewId}' não encontrada.`);
		}
		const now = state.updatedAt || systemClock();
		const upsert = this.db.query(
			`INSERT INTO findings
				(id, review_id, short_id, fingerprint, watchdog_ids, rule, severity,
				 file, line, message, action, evidence, anchor, found_at_sha, count,
				 present, decision, comment, exec_state, github, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				short_id = excluded.short_id,
				fingerprint = excluded.fingerprint,
				watchdog_ids = excluded.watchdog_ids,
				rule = excluded.rule,
				severity = excluded.severity,
				file = excluded.file,
				line = excluded.line,
				message = excluded.message,
				action = excluded.action,
				evidence = excluded.evidence,
				anchor = excluded.anchor,
				found_at_sha = excluded.found_at_sha,
				count = excluded.count,
				present = excluded.present,
				decision = excluded.decision,
				comment = excluded.comment,
				exec_state = excluded.exec_state,
				github = excluded.github,
				updated_at = excluded.updated_at`,
		);
		const deleteHistory = this.db.query(
			"DELETE FROM finding_history WHERE finding_id = ?",
		);
		const insertHistory = this.db.query(
			`INSERT INTO finding_history
				(id, finding_id, at, decision, exec_state, comment, by)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		const transaction = this.db.transaction(() => {
			this.db.run(
				`UPDATE reviews
					SET reviewed_sha = ?, reviewed_at = ?, updated_at = ?
				  WHERE id = ?`,
				[
					state.reviewed?.headSha ?? null,
					state.reviewed?.at ?? null,
					now,
					reviewId,
				],
			);

			const existing = this.db
				.query("SELECT id, short_id FROM findings WHERE review_id = ?")
				.all(reviewId) as { id: string; short_id: string }[];
			const idByShort = new Map(existing.map((row) => [row.short_id, row.id]));
			const desired = new Set(Object.keys(state.findings));
			for (const row of existing) {
				if (!desired.has(row.short_id)) {
					this.db.run("DELETE FROM findings WHERE id = ?", [row.id]);
				}
			}

			for (const finding of Object.values(state.findings)) {
				const id = idByShort.get(finding.id) ?? randomUUID();
				upsert.run(
					id,
					reviewId,
					finding.id,
					finding.fingerprint,
					JSON.stringify(finding.watchdogIds),
					finding.rule,
					finding.severity,
					finding.file,
					finding.line,
					finding.message,
					finding.action,
					finding.evidence ?? null,
					finding.anchor ? JSON.stringify(finding.anchor) : null,
					finding.foundAtSha ?? null,
					finding.count,
					finding.present ? 1 : 0,
					finding.decision,
					finding.comment ?? null,
					finding.execState,
					finding.github ? JSON.stringify(finding.github) : null,
					finding.createdAt,
					finding.updatedAt,
				);
				deleteHistory.run(id);
				for (const entry of finding.history) {
					insertHistory.run(
						randomUUID(),
						id,
						entry.at,
						entry.decision,
						entry.execState,
						entry.comment ?? null,
						entry.by ?? null,
					);
				}
			}
		});
		transaction();
	}

	// -----------------------------------------------------------------------
	// Artefatos
	// -----------------------------------------------------------------------

	readArtifact(reviewId: string, name: string): ArtifactRecord | null {
		const row = this.db
			.query("SELECT * FROM artifacts WHERE review_id = ? AND name = ?")
			.get(reviewId, name) as ArtifactRow | null;
		return row ? artifactFromRow(row) : null;
	}

	writeArtifact(reviewId: string, input: WriteArtifactInput): ArtifactRecord {
		if (!this.getReview(reviewId)) {
			throw new Error(`Review '${reviewId}' não encontrada.`);
		}
		const now = systemClock();
		const contentType =
			input.contentType ??
			(input.name.toLowerCase().endsWith(".json")
				? "application/json; charset=utf-8"
				: "text/markdown; charset=utf-8");
		const existing = this.readArtifact(reviewId, input.name);
		if (existing) {
			this.db.run(
				`UPDATE artifacts
					SET kind = ?, content = ?, content_type = ?, updated_at = ?
				  WHERE id = ?`,
				[input.kind, input.content, contentType, now, existing.id],
			);
			return this.readArtifact(reviewId, input.name) as ArtifactRecord;
		}
		const record: ArtifactRecord = {
			id: randomUUID(),
			reviewId,
			name: input.name,
			kind: input.kind,
			content: input.content,
			contentType,
			createdAt: now,
			updatedAt: now,
		};
		this.db.run(
			`INSERT INTO artifacts
				(id, review_id, name, kind, content, content_type, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				record.id,
				record.reviewId,
				record.name,
				record.kind,
				record.content,
				record.contentType,
				record.createdAt,
				record.updatedAt,
			],
		);
		return record;
	}

	listArtifacts(reviewId: string): ArtifactRecord[] {
		const rows = this.db
			.query("SELECT * FROM artifacts WHERE review_id = ? ORDER BY name")
			.all(reviewId) as ArtifactRow[];
		return rows.map(artifactFromRow);
	}

	deleteArtifact(reviewId: string, name: string): void {
		this.db.run("DELETE FROM artifacts WHERE review_id = ? AND name = ?", [
			reviewId,
			name,
		]);
	}

	// -----------------------------------------------------------------------
	// Manutenção / ciclo de vida
	// -----------------------------------------------------------------------

	maintain(): void {
		this.db.exec("PRAGMA optimize;");
		this.db.exec("VACUUM;");
	}

	location(reviewId: string): string {
		return `sqlite:${this.path}#${reviewId}`;
	}

	close(): void {
		this.db.close();
	}

	private requireReview(id: string): ReviewRecord {
		const review = this.getReview(id);
		if (!review) throw new Error(`Review '${id}' não encontrada.`);
		return review;
	}
}
