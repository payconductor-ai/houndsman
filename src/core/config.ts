/**
 * Contrato de configuração do motor de revisão (houndsman) — biblioteca.
 *
 * O motor (`core/` + `cli/`) é agnóstico ao projeto: consome um `ReviewConfig`
 * por injeção explícita. O projeto fornece a config em `houndsman.config.ts`
 * (camada `houndsman/`) — único ponto de troca ao portar para outro repositório.
 */

import { ARTIFACT_DIR } from "./paths";
import type { ReviewerDefinition } from "./types";

/** Documentos sempre incluídos nos briefs (default). */
export const DEFAULT_ALWAYS_INCLUDE_DOCS: readonly string[] = ["AGENTS.md"];

/**
 * Configuração completa do motor de revisão para um projeto.
 *
 * `TId` é o union de ids de revisor do projeto (ex.: `ReviewerId`).
 */
export type ReviewConfig<TId extends string = string> = {
	/** Nome legível do projeto (usado em prompts e docs). */
	projectName: string;
	/** Diretório dos artefatos (default: `ARTIFACT_DIR` da camada). */
	artifactDir?: string;
	/**
	 * Ids dos revisores — **derivados** das chaves de `reviewers` por
	 * `defineReviewConfig` (não informar manualmente).
	 */
	reviewerIds: readonly TId[];
	/** Definições dos revisores do projeto (fonte dos ids). */
	reviewers: Record<TId, ReviewerDefinition>;
	/** Arquivos que nunca entram na revisão. */
	exclusions: readonly RegExp[];
	/** Mapeamentos path → documentação relevante. */
	docMappings: readonly (readonly [RegExp, readonly string[]])[];
	/** Docs sempre incluídos nos briefs (default: `DEFAULT_ALWAYS_INCLUDE_DOCS`). */
	alwaysIncludeDocs?: readonly string[];
};

/** Entrada de `defineReviewConfig` — `reviewerIds` é derivado, não informado. */
export type ReviewConfigInput<TId extends string = string> = Omit<
	ReviewConfig<TId>,
	"reviewerIds"
>;

/**
 * Helper de autoria: **deriva `reviewerIds`** das chaves de `reviewers`
 * (fonte única) e preserva a inferência de `TId`.
 */
export function defineReviewConfig<TId extends string>(
	input: ReviewConfigInput<TId>,
): ReviewConfig<TId> {
	return { ...input, reviewerIds: Object.keys(input.reviewers) as TId[] };
}

/** Diretório dos artefatos — o valor do projeto ou o default da camada. */
export function resolveArtifactDir(config: ReviewConfig): string {
	return config.artifactDir ?? ARTIFACT_DIR;
}
