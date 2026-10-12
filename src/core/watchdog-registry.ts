/**
 * Acesso tipado aos revisores de um `ReviewConfig` (biblioteca).
 *
 * Substitui o antigo barrel `registry/`. O motor não conhece ids concretos —
 * tudo chega via `config`.
 */

import type { ReviewConfig } from "./config";
import type { ReviewerDefinition } from "./types";

/** Acesso tipado a um revisor do projeto (id string em runtime). */
export function getReviewer<TId extends string>(
	config: ReviewConfig<TId>,
	reviewerId: string,
): ReviewerDefinition {
	return config.reviewers[reviewerId as TId];
}

/** Busca null-safe por id string (runtime). */
export function findReviewer<TId extends string>(
	config: ReviewConfig<TId>,
	reviewerId: string,
): ReviewerDefinition | null {
	return config.reviewers[reviewerId as TId] ?? null;
}

/** Contexto "essencial" do revisor — SEM regras (docs/UI/inspeção). */
export function getReviewerContext<TId extends string>(
	config: ReviewConfig<TId>,
	reviewerId: string,
) {
	const { id, name, description, scope, reviewFocus, exclude, contextFiles } =
		getReviewer(config, reviewerId);
	return {
		id,
		name,
		description,
		scope,
		reviewFocus,
		exclude,
		contextFiles,
	};
}
