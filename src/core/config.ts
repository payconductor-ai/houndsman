/**
 * Contrato de configuração do motor de revisão (houndsman) — biblioteca.
 *
 * O motor (`core/` + `cli/`) é agnóstico ao projeto: consome um `HoundsmanConfig`
 * por injeção explícita. O projeto fornece a config em `houndsman.config.ts`
 * (camada `houndsman/`) — único ponto de troca ao portar para outro repositório.
 */

import type { AstLanguage } from "./ast/types";
import { ProjectConfig } from "./project-config";
import type { WatchdogDefinition } from "./types";

export {
	DEFAULT_AI_CONCURRENCY,
	DEFAULT_AI_MAX_CALLS_PER_REVIEW,
	DEFAULT_AI_MODEL,
	DEFAULT_AI_PROVIDER,
	DEFAULT_AI_TIMEOUT_MS,
	DEFAULT_ALWAYS_INCLUDE_DOCS,
	DEFAULT_AST_MAX_FILE_BYTES,
	DEFAULT_AST_MAX_IMPACT_FILES,
	DEFAULT_HUNT_CONCURRENCY,
	DEFAULT_HUNT_RETRIES,
	DEFAULT_HUNT_TIMEOUT_MS,
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAKI_VERSION,
	DEFAULT_MAX_FILES_PER_BRIEF,
} from "./defaults";

/** Limites de triage para PRs grandes. */
export type HoundsmanBudgets = {
	/** Máx. de arquivos por brief (default: 40). Excedente vai para "fora do orçamento". */
	maxFilesPerBrief?: number;
};

/** Configuração do subsistema AST (determinístico, sem LLM). */
export type HoundsmanAst = {
	/**
	 * Liga/desliga o AST (default: `true`). Com grammars ausentes ou ABI
	 * incompatível, o motor segue sem AST (fail-open).
	 */
	enabled?: boolean;
	/** Teto de bytes por arquivo (default: 512_000). */
	maxFileBytes?: number;
	/** Teto de arquivos candidatos na análise de impacto (default: 200). */
	maxImpactFiles?: number;
	/** Override de extensão → linguagem (`".vue": "typescript"`). */
	languages?: Record<string, AstLanguage>;
	/** Aliases de import (`"@/": "src/"`). */
	aliases?: Record<string, string>;
};

/** Concorrência das fases paralelas internas. */
export type HoundsmanConcurrency = {
	/** Chamadas Jev simultâneas (default: 5). */
	jev?: number;
};

/** Providers suportados pela camada de IA. */
export type AiProviderKind = "deepseek" | "openai" | "anthropic";

/**
 * Opções do AI SDK indexadas pelo id do provider
 * (`{ deepseek: { thinking: { type: "disabled" } } }`).
 *
 * O motor não interpreta o conteúdo: só repassa. Use para controlar
 * thinking/reasoning sem acoplar a config a um provider específico.
 */
export type AiProviderOptions = Record<string, Record<string, unknown>>;

/** Features de IA do fluxo determinístico (todas fail-open). */
export type HoundsmanAiFeatures = {
	/** Resume o contexto da PR (`context-summary`) quando o subagente não gerou. */
	context?: boolean;
	/** Reconstrói a intenção da PR (`business-summary`) antes dos watchdogs. */
	business?: boolean;
	/** Enriquece os briefs com um plano de revisão sugerido. */
	brief?: boolean;
	/** Gera os pontos técnicos estruturais do resumo final. */
	technical?: boolean;
	/** Classifica arquivos que nenhum watchdog casou. */
	classification?: boolean;
	/** Gera candidatos de pré-análise (substitui o Jev quando disponível). */
	preAnalysis?: boolean;
	/** Confirma/refuta findings ambíguos no `verify`. */
	verify?: boolean;
};

/** Overrides de IA por watchdog. */
export type HoundsmanAiWatchdog = {
	model?: string;
};

/** Configuração da camada de IA (briefs, contexto, classificação, pré-análise, verify). */
export type HoundsmanAi = {
	/** Liga a IA do fluxo normal (default: `true`; sem chave é fail-open). */
	enabled?: boolean;
	/** Provider de modelo (default: `deepseek`). */
	provider?: AiProviderKind;
	/** Modelo (default em `defaults.ts`). */
	model?: string;
	/** Base URL customizada do provider. */
	baseURL?: string;
	/** Chamadas simultâneas (default: 2). */
	concurrency?: number;
	/** Opções do AI SDK por provider (repassadas sem interpretação). */
	providerOptions?: AiProviderOptions;
	/** Timeout por chamada em ms (default: 120_000). */
	timeoutMs?: number;
	/** Teto de chamadas por review (default: 40). */
	maxCallsPerReview?: number;
	/** Teto de tokens por review. */
	maxTokensPerReview?: number;
	/** Features do fluxo normal. */
	features?: HoundsmanAiFeatures;
	/** Overrides por watchdog. */
	watchdogs?: Record<string, HoundsmanAiWatchdog>;
};

/** Onde os worktrees de revisão são criados. */
export type HoundsmanWorktrees = {
	/**
	 * `workspace` (default): `<repo>/.houndsman/worktrees` — dentro da pasta
	 * aberta no editor, então agentes com permissão escopada ao workspace
	 * conseguem ler/executar sem prompts. `home`: `<HOUNDSMAN_HOME>/worktrees`.
	 * Qualquer outro valor é um caminho (absoluto ou relativo à raiz do repo).
	 */
	location?: "home" | "workspace" | string;
};

/**
 * Harness local da capability `hunt` (`houndsman hunt`) — opcional.
 *
 * Sem esta config, o comando usa defaults seguros: modelo derivado de `ai`,
 * 4 processos simultâneos e timeout de 15 min por watchdog. A skill
 * `/houndsman hunt` (harness externo) não depende deste bloco.
 */
export type HoundsmanHunt = {
	/** Desliga o harness local sem desinstalar o binário (default: ligado). */
	enabled?: boolean;
	/** Modelo no formato do maki (`provider/model-id`). Default: derivado de `ai`. */
	model?: string;
	/** Processos maki simultâneos (default: 4). */
	concurrency?: number;
	/** Timeout por watchdog em ms (default: 900_000). */
	timeoutMs?: number;
	/** Tentativas extras quando a saída do watchdog é inválida (default: 1). */
	retries?: number;
	/** Caminho explícito do binário (`HOUNDSMAN_MAKI_PATH` tem precedência). */
	binaryPath?: string;
};

/** Backend de persistência (reviews, findings e artefatos). */
export type HoundsmanStorage = {
	/**
	 * Provider de storage (default: `sqlite`). `file` mantém o formato antigo
	 * em arquivos, mas sob o diretório global do houndsman.
	 */
	provider?: "sqlite" | "file";
	/**
	 * Caminho do banco (sqlite) ou raiz das runs (file). Default:
	 * `<HOUNDSMAN_HOME>/houndsman.db` / `<HOUNDSMAN_HOME>/runs`.
	 */
	path?: string;
};

/**
 * Configuração completa do motor de revisão para um projeto.
 *
 * `TId` é o union de ids de watchdog do projeto (ex.: `WatchdogId`).
 */
export type HoundsmanConfig<TId extends string = string> = {
	/** Nome legível do projeto (usado em prompts e docs). */
	projectName: string;
	/** Persistência das runs e artefatos (default: SQLite global). */
	storage?: HoundsmanStorage;
	/** Localização dos worktrees de revisão (default: dentro do workspace). */
	worktrees?: HoundsmanWorktrees;
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
	/** AST determinístico (classificação estrutural, brief e impacto). */
	ast?: HoundsmanAst;
	/** Camada de IA (briefs, contexto, classificação, pré-análise e verify). */
	ai?: HoundsmanAi;
	/** Harness local da capability `hunt` (maki) — opcional. */
	hunt?: HoundsmanHunt;
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
