/**
 * Fachada da orquestração do houndsman (biblioteca).
 *
 * O trabalho vive nas pipelines (`PreparePipeline`/`FinalizePipeline`), que
 * recebem o `ReviewContext` no construtor. Aqui ficam apenas os tipos, os
 * defaults e as fachadas usadas pelo `ReviewSession` e pelos testes.
 *
 * Genérico: recebe o `HoundsmanConfig` por parâmetro (injeção explícita).
 * Entrypoints: `cli/index.ts` (`houndsman`). Aqui não há `process.argv`.
 */

import type { HoundsmanConfig } from "./config";
import { FinalizePipeline, type FinalizeResult } from "./engine/finalize-pipeline";
import {
	type PrepareDeps,
	PreparePipeline,
	type PrepareResult,
} from "./engine/prepare-pipeline";
import type { ReviewContext } from "./engine/review-context";
import type { ReviewOptions } from "./engine/review-options";
import { GitRepository } from "./services/git-repository";

export type { FinalizeResult } from "./engine/finalize-pipeline";
export type {
	PrepareDeps,
	PrepareProgress,
	PrepareProgressEvent,
	PrepareResult,
	PrepareStage,
} from "./engine/prepare-pipeline";
export type { ReviewContext, ReviewWorkspaceContext } from "./engine/review-context";
export { reviewContext } from "./engine/review-context";
export type { ReviewOptions } from "./engine/review-options";
export { defaultOptions } from "./engine/review-options";

/** Passo 1 — descobre os arquivos e grava briefs + manifesto. */
export function prepare(
	ctx: ReviewContext,
	config: HoundsmanConfig,
	opts: ReviewOptions,
	deps: PrepareDeps = {},
): Promise<PrepareResult> {
	return new PreparePipeline(ctx, config, opts, deps).run();
}

/** Passo 2 — consolida os findings no resumo final. */
export function finalize(
	ctx: ReviewContext,
	config: HoundsmanConfig,
	opts: ReviewOptions,
): FinalizeResult {
	return new FinalizePipeline(ctx, config, opts).run();
}

/** Resolve a branch (opção explícita ou a atual do git). */
export function resolveBranch(
	opts: ReviewOptions,
	git: GitRepository = new GitRepository(),
): string {
	if (opts.branch) return opts.branch;
	const branch = git.currentBranch();
	if (!branch) {
		throw new Error("Não foi possível detectar a branch. Use --branch <nome>.");
	}
	return branch;
}
