/**
 * Provider de arquivos do houndsman (biblioteca) — fallback do SQLite.
 *
 * Mantém o formato antigo (JSON por review), mas sob o diretório global do
 * houndsman. Serve para debug/rollback: trocar `storage.provider` para `"file"`.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FINDINGS_STATE_VERSION, type FindingsStateFile } from "../../findings-state";
import { systemClock } from "../../services/clock";
import { ProjectFiles } from "../../services/project-files";
import type {
	ArtifactRecord,
	CreateReviewInput,
	ReviewPatch,
	ReviewRecord,
	StorageProvider,
	WriteArtifactInput,
} from "../types";

const REVIEW_FILE = "review.json";
const FINDINGS_FILE = "findings.json";
const ARTIFACTS_FILE = "artifacts.json";

/** Provider em arquivos sob uma raiz global. */
export class FileStorageProvider implements StorageProvider {
	readonly kind = "file" as const;
	private readonly root: string;
	private readonly files = new ProjectFiles();

	constructor(root: string) {
		this.root = root;
	}

	// -----------------------------------------------------------------------
	// Reviews
	// -----------------------------------------------------------------------

	getOrCreateReview(input: CreateReviewInput): ReviewRecord {
		const existing = this.findReview(input.repo.key, input.branch);
		if (existing) {
			if (
				existing.repoRoot !== input.repo.root ||
				existing.repoRemote !== input.repo.remote
			) {
				return this.writeReview({
					...existing,
					repoRoot: input.repo.root,
					repoRemote: input.repo.remote,
				});
			}
			return existing;
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
		return this.writeReview(record);
	}

	findReview(repoKey: string, branch: string): ReviewRecord | null {
		return (
			this.readReviews(repoKey).find((review) => review.branch === branch) ?? null
		);
	}

	getReview(id: string): ReviewRecord | null {
		return this.readReviews().find((review) => review.id === id) ?? null;
	}

	listReviews(repoKey?: string): ReviewRecord[] {
		return this.readReviews(repoKey).sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		);
	}

	updateReview(id: string, patch: ReviewPatch): ReviewRecord | null {
		const review = this.getReview(id);
		if (!review) return null;
		const now = patch.updatedAt ?? systemClock();
		const updated: ReviewRecord = { ...review };
		if (patch.branch !== undefined) updated.branch = patch.branch;
		if (patch.slug !== undefined) updated.slug = patch.slug;
		if (patch.base !== undefined) updated.base = patch.base;
		if (patch.head !== undefined) updated.head = patch.head;
		if (patch.headSha !== undefined) updated.headSha = patch.headSha;
		if (patch.reviewedSha !== undefined) updated.reviewedSha = patch.reviewedSha;
		if (patch.reviewedAt !== undefined) updated.reviewedAt = patch.reviewedAt;
		if (patch.status !== undefined) updated.status = patch.status;
		if (patch.resetStartedAt) updated.startedAt = now;
		else if (patch.startedAt !== undefined) updated.startedAt = patch.startedAt;
		updated.updatedAt = patch.updatedAt ?? now;
		return this.writeReview(updated);
	}

	deleteReview(id: string): void {
		const review = this.getReview(id);
		if (!review) return;
		this.files.removeDir(this.reviewDir(review));
	}

	// -----------------------------------------------------------------------
	// Findings
	// -----------------------------------------------------------------------

	readFindings(reviewId: string): FindingsStateFile | null {
		const review = this.getReview(reviewId);
		if (!review) return null;
		const raw = this.files.readJson<FindingsStateFile>(
			join(this.reviewDir(review), FINDINGS_FILE),
		);
		if (!raw || raw.version !== FINDINGS_STATE_VERSION || !raw.findings) return null;
		return raw;
	}

	writeFindings(reviewId: string, state: FindingsStateFile): void {
		const review = this.getReview(reviewId);
		if (!review) throw new Error(`Review '${reviewId}' não encontrada.`);
		this.writeJson(join(this.reviewDir(review), FINDINGS_FILE), state);
		this.writeReview({
			...review,
			reviewedSha: state.reviewed?.headSha,
			reviewedAt: state.reviewed?.at,
			updatedAt: state.updatedAt || systemClock(),
		});
	}

	// -----------------------------------------------------------------------
	// Artefatos
	// -----------------------------------------------------------------------

	readArtifact(reviewId: string, name: string): ArtifactRecord | null {
		const review = this.getReview(reviewId);
		if (!review) return null;
		return this.readArtifacts(review)[name] ?? null;
	}

	writeArtifact(reviewId: string, input: WriteArtifactInput): ArtifactRecord {
		const review = this.getReview(reviewId);
		if (!review) throw new Error(`Review '${reviewId}' não encontrada.`);
		const index = this.readArtifacts(review);
		const now = systemClock();
		const existing = index[input.name];
		const contentType =
			input.contentType ??
			(input.name.toLowerCase().endsWith(".json")
				? "application/json; charset=utf-8"
				: "text/markdown; charset=utf-8");
		const record: ArtifactRecord = {
			id: existing?.id ?? randomUUID(),
			reviewId,
			name: input.name,
			kind: input.kind,
			content: input.content,
			contentType,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		index[input.name] = record;
		this.writeJson(join(this.reviewDir(review), ARTIFACTS_FILE), index);
		return record;
	}

	listArtifacts(reviewId: string): ArtifactRecord[] {
		const review = this.getReview(reviewId);
		if (!review) return [];
		return Object.values(this.readArtifacts(review)).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	deleteArtifact(reviewId: string, name: string): void {
		const review = this.getReview(reviewId);
		if (!review) return;
		const index = this.readArtifacts(review);
		if (!index[name]) return;
		delete index[name];
		this.writeJson(join(this.reviewDir(review), ARTIFACTS_FILE), index);
	}

	// -----------------------------------------------------------------------
	// Manutenção / ciclo de vida
	// -----------------------------------------------------------------------

	maintain(): void {
		// Nada a compactar: arquivos JSON são reescritos por inteiro.
	}

	location(reviewId: string): string {
		const review = this.getReview(reviewId);
		return review
			? `file:${join(this.reviewDir(review), FINDINGS_FILE)}#${reviewId}`
			: `file:${this.root}#${reviewId}`;
	}

	close(): void {
		// Sem recurso aberto.
	}

	// -----------------------------------------------------------------------
	// Internos
	// -----------------------------------------------------------------------

	private repoDir(repoKey: string): string {
		const hash = createHash("sha256").update(repoKey).digest("hex").slice(0, 16);
		return join(this.root, hash);
	}

	private reviewDir(review: ReviewRecord): string {
		return join(this.repoDir(review.repoKey), review.slug);
	}

	private writeReview(record: ReviewRecord): ReviewRecord {
		this.writeJson(join(this.reviewDir(record), REVIEW_FILE), record);
		return record;
	}

	private readReviews(repoKey?: string): ReviewRecord[] {
		const roots = repoKey ? [this.repoDir(repoKey)] : this.subdirectories(this.root);
		const reviews: ReviewRecord[] = [];
		for (const repoDir of roots) {
			for (const slugDir of this.subdirectories(repoDir)) {
				const review = this.files.readJson<ReviewRecord>(
					join(slugDir, REVIEW_FILE),
				);
				if (review && (!repoKey || review.repoKey === repoKey)) {
					reviews.push(review);
				}
			}
		}
		return reviews;
	}

	private readArtifacts(review: ReviewRecord): Record<string, ArtifactRecord> {
		return (
			this.files.readJson<Record<string, ArtifactRecord>>(
				join(this.reviewDir(review), ARTIFACTS_FILE),
			) ?? {}
		);
	}

	private writeJson(path: string, value: unknown): void {
		this.files.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
	}

	private subdirectories(dir: string): string[] {
		if (!existsSync(dir)) return [];
		try {
			return readdirSync(dir)
				.map((name) => join(dir, name))
				.filter((path) => statSync(path).isDirectory());
		} catch {
			return [];
		}
	}
}
