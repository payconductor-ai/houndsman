/**
 * Contrato de configuração do motor de revisão (houndsman) — biblioteca.
 *
 * O motor (`core/` + `cli/`) é agnóstico ao projeto: consome um `HoundsmanConfig`
 * por injeção explícita. O projeto fornece a config em `houndsman.config.ts`
 * (camada `houndsman/`) — único ponto de troca ao portar para outro repositório.
 */

import { ProjectConfig } from "./project-config";
import type { WatchdogDefinition } from "./types";

export {
	DEFAULT_ALWAYS_INCLUDE_DOCS,
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAX_FILES_PER_BRIEF,
} from "./defaults";

/** Limites de triage para PRs grandes. */
export type HoundsmanBudgets = {
	/** Máx. de arquivos por brief (default: 40). Excedente vai para "fora do orçamento". */
	maxFilesPerBrief?: number;
};

/** Concorrência das fases paralelas internas. */
export type HoundsmanConcurrency = {
	/** Chamadas Jev simultâneas (default: 5). */
	jev?: number;
};

/**
 * Configuração completa do motor de revisão para um projeto.
 *
 * `TId` é o union de ids de watchdog do projeto (ex.: `WatchdogId`).
 */
export type HoundsmanConfig<TId extends string = string> = {
	/** Nome legível do projeto (usado em prompts e docs). */
	projectName: string;
	/** Diretório dos artefatos (default: `ARTIFACT_DIR` da camada). */
	artifactDir?: string;
	/**
	 * Ids dos watchdogs — **derivados** das chaves de `watchdogs` por
	 * `defineHoundsmanConfig` (não informar manualmente).
	 */
	watchdogIds: readonly TId[];
	/** Definições dos watchdogs do projeto (fonte dos ids). */
	watchdogs: Record<TId, WatchdogDefinition>;
	/** Arquivos que nunca entram na revisão. */
	exclusions: readonly RegExp[];
	/** Mapeamentos path → documentação relevante. */
	docMappings: readonly (readonly [RegExp, readonly string[]])[];
	/** Docs sempre incluídos nos briefs (default: `DEFAULT_ALWAYS_INCLUDE_DOCS`). */
	alwaysIncludeDocs?: readonly string[];
	/** Limites de triage para PRs grandes (default: `DEFAULT_MAX_FILES_PER_BRIEF`). */
	budgets?: HoundsmanBudgets;
	/** Concorrência das fases paralelas internas. */
	concurrency?: HoundsmanConcurrency;
};

/** Entrada de `defineHoundsmanConfig` — `watchdogIds` é derivado, não informado. */
export type HoundsmanConfigInput<TId extends string = string> = Omit<
	HoundsmanConfig<TId>,
	"watchdogIds"
>;

/**
 * Helper de autoria: **deriva `watchdogIds`** das chaves de `watchdogs`
 * (fonte única) e preserva a inferência de `TId`.
 */
export function defineHoundsmanConfig<TId extends string>(
	input: HoundsmanConfigInput<TId>,
): HoundsmanConfig<TId> {
	return { ...input, watchdogIds: Object.keys(input.watchdogs) as TId[] };
}

/** Diretório dos artefatos — o valor do projeto ou o default da camada. */
export function resolveArtifactDir(config: HoundsmanConfig): string {
	return new ProjectConfig(config).artifactDir;
}

/**
 * Teto de arquivos por brief. Valor ausente/não-positivo cai no default —
 * mantém o contexto do subagente limitado em PRs grandes.
 */
export function resolveMaxFilesPerBrief(config: HoundsmanConfig): number {
	return new ProjectConfig(config).maxFilesPerBrief;
}

/** Concorrência das chamadas Jev (valor ausente/não-positivo cai no default). */
export function resolveJevConcurrency(config: HoundsmanConfig): number {
	return new ProjectConfig(config).jevConcurrency;
}
