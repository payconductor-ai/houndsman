/**
 * Sessão de uma run (engine) — amarra opções, branch, storage e staging.
 *
 * É o ponto de entrada do `prepare`/`finalize` para o CLI e para o engine.
 */

import type { AiClient } from "../ai/ai-client";
import type { AstService } from "../ast/service";
import type { HoundsmanConfig } from "../config";
import {
	type FinalizeResult,
	finalize,
	type PrepareResult,
	prepare,
	type ReviewContext,
	type ReviewOptions,
	resolveBranch,
	reviewContext,
} from "../orchestrator";
import { sanitizeBranch } from "../report-builder";
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
	) {
		this.config = config;
		this.options = options;
		this.branch = branch;
		this.ast = ast;
		this.ai = ai;
		const review = options.finalize
			? storage.findReview(repo.key, branch)
			: storage.getOrCreateReview({
					repo,
					branch,
					slug: sanitizeBranch(branch),
					base: options.base,
					head: options.head,
				});
		if (!review) {
			throw new Error(
				`Nenhuma revisão para '${branch}'. Rode \`houndsman\` (preparar) primeiro.`,
			);
		}
		this.context = reviewContext(storage, review);
	}

	/** Resolve a branch (opção explícita ou a atual do git). */
	static from(
		config: HoundsmanConfig,
		options: ReviewOptions,
		storage: StorageProvider,
		repo: RepoIdentity,
		ast?: AstService,
		ai?: AiClient,
	): ReviewSession {
		return new ReviewSession(
			config,
			options,
			resolveBranch(options),
			storage,
			repo,
			ast,
			ai,
		);
	}

	/** Passo 1 — preparar. */
	prepare(): Promise<PrepareResult> {
		return prepare(
			this.options,
			this.branch,
			this.config,
			this.context,
			this.ast,
			this.ai,
		);
	}

	/** Passo 3 — finalizar. */
	finalize(): FinalizeResult {
		return finalize(this.options, this.branch, this.config, this.context);
	}

	/** Executa o passo escolhido em `--finalize`. */
	run(): Promise<PrepareResult | FinalizeResult> {
		return this.options.finalize ? Promise.resolve(this.finalize()) : this.prepare();
	}
}
