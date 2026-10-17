/**
 * Sessão de uma run (engine) — amarra opções, branch e layout.
 *
 * É o ponto de entrada do `prepare`/`finalize` para o CLI e para o engine.
 */

import type { HoundsmanConfig } from "../config";
import {
	type FinalizeResult,
	finalize,
	type PrepareResult,
	prepare,
	type ReviewOptions,
	resolveBranch,
} from "../orchestrator";
import { RunLayout } from "../run-layout";

/** Uma revisão em andamento (prepare ou finalize). */
export class ReviewSession {
	readonly config: HoundsmanConfig;
	readonly options: ReviewOptions;
	readonly branch: string;
	readonly layout: RunLayout;

	constructor(config: HoundsmanConfig, options: ReviewOptions, branch: string) {
		this.config = config;
		this.options = options;
		this.branch = branch;
		this.layout = new RunLayout(options.dir, branch);
	}

	/** Resolve a branch (opção explícita ou a atual do git). */
	static from(config: HoundsmanConfig, options: ReviewOptions): ReviewSession {
		return new ReviewSession(config, options, resolveBranch(options));
	}

	/** Passo 1 — preparar. */
	prepare(): Promise<PrepareResult> {
		return prepare(this.options, this.branch, this.config, this.layout);
	}

	/** Passo 3 — finalizar. */
	finalize(): FinalizeResult {
		return finalize(this.options, this.branch, this.config, this.layout);
	}

	/** Executa o passo escolhido em `--finalize`. */
	run(): Promise<PrepareResult | FinalizeResult> {
		return this.options.finalize ? Promise.resolve(this.finalize()) : this.prepare();
	}
}
