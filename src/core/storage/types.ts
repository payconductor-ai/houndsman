/**
 * Contrato de persistência do houndsman (biblioteca).
 *
 * Tudo que hoje é "run" (reviews, findings, artefatos) passa por aqui. As
 * implementações (`SQLiteStorageProvider` e `FileStorageProvider`) compartilham
 * esta interface — trocar o backend é só trocar a config.
 */

import type { FindingsStateFile } from "../findings-state";

/** Estados de execução de uma run. */
export type ReviewStatus = "reviewing" | "review_done" | "fixing" | "fix_done";

/** Identidade estável de um repositório (remote normalizado ou raiz git). */
export type RepoIdentity = {
	/** Chave usada para escopar as runs (`remote:<...>` ou `path:<...>`). */
	key: string;
	/** Raiz absoluta do repositório no disco. */
	root: string;
	/** Remote `origin` cru, quando existir. */
	remote?: string;
};

/** Registro de uma revisão (run de uma branch). */
export type ReviewRecord = {
	id: string;
	repoKey: string;
	repoRoot: string;
	repoRemote?: string;
	branch: string;
	slug: string;
	base?: string;
	head?: string;
	headSha?: string;
	reviewedSha?: string;
	reviewedAt?: string;
	/** Worktree onde a revisão roda (ausente = clone principal). */
	worktreePath?: string;
	/** Número da PR revisada (quando iniciada via `--pr`). */
	prNumber?: number;
	status: ReviewStatus | null;
	startedAt?: string;
	/**
	 * Último sinal de vida de uma execução ativa (`reviewing`/`fixing`).
	 * Diferente de `updatedAt`: não muda com triagem/sync — só com a execução.
	 */
	heartbeatAt?: string;
	createdAt: string;
	updatedAt: string;
};

/** Campos mutáveis de uma review (os demais são identidade). */
export type ReviewPatch = Partial<
	Pick<
		ReviewRecord,
		| "branch"
		| "slug"
		| "base"
		| "head"
		| "headSha"
		| "reviewedSha"
		| "reviewedAt"
		| "worktreePath"
		| "prNumber"
		| "status"
		| "startedAt"
		| "heartbeatAt"
		| "updatedAt"
	>
> & {
	/** Reinicia o `startedAt` no início de um novo ciclo de revisão. */
	resetStartedAt?: boolean;
	/** Limpa o heartbeat (execução terminou). */
	resetHeartbeat?: boolean;
	/** Limpa `worktreePath`/`prNumber` (review voltou ao clone principal). */
	resetWorkspace?: boolean;
};

/** Entrada de `getOrCreateReview`. */
export type CreateReviewInput = {
	repo: RepoIdentity;
	branch: string;
	slug: string;
	base?: string;
	head?: string;
	/** Worktree onde a revisão roda (ausente = clone principal). */
	worktreePath?: string;
	/** Número da PR revisada (quando iniciada via `--pr`). */
	prNumber?: number;
	now?: string;
};

/** Espécie de artefato (orienta a UI e o manifesto). */
export type ArtifactKind =
	| "brief"
	| "classification"
	| "manifest"
	| "candidates"
	| "context"
	| "context-brief"
	| "context-summary"
	| "finding-report"
	| "review"
	| "resume"
	| "technical"
	| "domain-review"
	| "verify"
	| "ast"
	| "ast-impact"
	| "ai"
	| "ai-usage"
	| "ai-brief"
	| "harness-transcript"
	| "other";

/** Artefato persistido de uma review. */
export type ArtifactRecord = {
	id: string;
	reviewId: string;
	name: string;
	kind: ArtifactKind;
	content: string;
	contentType: string;
	createdAt: string;
	updatedAt: string;
};

/** Entrada de `writeArtifact`. */
export type WriteArtifactInput = {
	name: string;
	kind: ArtifactKind;
	content: string;
	contentType?: string;
};

/**
 * Persistência síncrona de reviews, findings e artefatos.
 *
 * Síncrona de propósito: `bun:sqlite` e o filesystem são síncronos, e o motor
 * inteiro já trabalha nesse modelo.
 */
export interface StorageProvider {
	readonly kind: "sqlite" | "file";

	/** Recupera ou cria a review de uma branch (identidade = repo + branch). */
	getOrCreateReview(input: CreateReviewInput): ReviewRecord;
	findReview(repoKey: string, branch: string): ReviewRecord | null;
	getReview(id: string): ReviewRecord | null;
	/** Reviews do repositório (mais recentes primeiro); sem chave = todas. */
	listReviews(repoKey?: string): ReviewRecord[];
	updateReview(id: string, patch: ReviewPatch): ReviewRecord | null;
	deleteReview(id: string): void;

	/** Estado de triagem completo; null se a review ainda não tem findings. */
	readFindings(reviewId: string): FindingsStateFile | null;
	/** Substitui o estado de triagem (transacional no SQLite). */
	writeFindings(reviewId: string, state: FindingsStateFile): void;

	readArtifact(reviewId: string, name: string): ArtifactRecord | null;
	writeArtifact(reviewId: string, input: WriteArtifactInput): ArtifactRecord;
	listArtifacts(reviewId: string): ArtifactRecord[];
	deleteArtifact(reviewId: string, name: string): void;

	/** Manutenção do backend (SQLite: `PRAGMA optimize` + `VACUUM`). */
	maintain(): void;

	/** Referência legível do armazenamento de uma review (diagnóstico/logs). */
	location(reviewId: string): string;

	close(): void;
}
