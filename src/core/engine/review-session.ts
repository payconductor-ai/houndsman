/**
 * Sessão de uma run (engine) — amarra opções, branch, storage e staging.
 *
 * É o ponto de entrada do `prepare`/`finalize` para o CLI e para o engine.
 */

import type { AiClient } from "../ai/ai-client";
import type { AstService } from "../ast/service";
import type { HoundsmanConfig } from "../config";
import { createGitRunner } from "../git-runner";
import {
	type FinalizeResult,
	finalize,
	type PrepareProgress,
	type PrepareResult,
	prepare,
	type ReviewContext,
	type ReviewOptions,
	type ReviewWorkspaceContext,
	resolveBranch,
	reviewContext,
} from "../orchestrator";
import { reviewSlug } from "../report-builder";
import { GitRepository } from "../services/git-repository";
import type { RepoIdentity, StorageProvider } from "../storage/types";

/** Uma revisão em andamento (prepare ou finalize). */
export class ReviewSession {
	readonly config: HoundsmanConfig;
	readonly options: ReviewOptions;
	readonly branch: string;
	readonly context: ReviewContext;
	private readonly ast?: AstService;
	private readonly ai?: AiClient;

	constructor(
		config: HoundsmanConfig,
		options: ReviewOptions,
		branch: string,
		storage: StorageProvider,
		repo: RepoIdentity,
		ast?: AstService,
		ai?: AiClient,
		workspace?: ReviewWorkspaceContext,
	) {
		this.config = config;
		this.options = options;
		this.branch = branch;
		this.ast = ast;
		this.ai = ai;
		const variant = options.variant?.trim() || undefined;
		const review = options.finalize
			? storage.findReview(repo.key, branch, variant)
			: storage.getOrCreateReview({
					repo,
					branch,
					variant,
					slug: reviewSlug(branch, variant),
					base: options.base,
					head: options.head,
					worktreePath: options.worktreePath,
					prNumber: options.pr,
				});
		if (!review) {
			throw new Error(
				`Nenhuma revisão para '${branch}'${variant ? ` (variante '${variant}')` : ""}. Rode \`houndsman\` (preparar) primeiro.`,
			);
		}
		// Um prepare no clone principal invalida um worktree usado antes; o finalize
		// não mexe (pode ser rodado de outro lugar depois do prepare no worktree).
		const current =
			!options.finalize && !options.worktreePath && review.worktreePath
				? (storage.updateReview(review.id, { resetWorkspace: true }) ?? review)
				: review;
		// Finalize sem flag explícita reusa o worktree gravado no prepare.
		const effective =
			options.finalize && !options.worktreePath && current.worktreePath
				? {
						root: current.worktreePath,
						mainRoot: workspace?.mainRoot,
						git: new GitRepository(createGitRunner(current.worktreePath)),
					}
				: workspace;
		this.context = reviewContext(storage, current, effective);
	}

	/** Resolve a branch (opção explícita ou a atual do git). */
	static from(
		config: HoundsmanConfig,
		options: ReviewOptions,
		storage: StorageProvider,
		repo: RepoIdentity,
		ast?: AstService,
		ai?: AiClient,
		workspace?: ReviewWorkspaceContext,
	): ReviewSession {
		return new ReviewSession(
			config,
			options,
			resolveBranch(options, workspace?.git),
			storage,
			repo,
			ast,
			ai,
			workspace,
		);
	}

	/** Passo 1 — preparar. */
	prepare(onProgress?: PrepareProgress): Promise<PrepareResult> {
		return prepare(
			this.options,
			this.branch,
			this.config,
			this.context,
			this.ast,
			this.ai,
			onProgress,
		);
	}

	/** Passo 3 — finalizar. */
	finalize(): FinalizeResult {
		return finalize(this.options, this.branch, this.config, this.context);
	}

	/** Executa o passo escolhido em `--finalize`. */
	run(onProgress?: PrepareProgress): Promise<PrepareResult | FinalizeResult> {
		return this.options.finalize
			? Promise.resolve(this.finalize())
			: this.prepare(onProgress);
	}
}
