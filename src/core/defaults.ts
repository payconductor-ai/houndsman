/**
 * Defaults do motor (biblioteca) — valores canônicos compartilhados.
 *
 * Vivem fora de `config.ts` para que `ProjectConfig` possa usá-los sem criar
 * ciclo de importação com os adaptadores públicos.
 */

/** Documentos sempre incluídos nos briefs (default). */
export const DEFAULT_ALWAYS_INCLUDE_DOCS: readonly string[] = ["AGENTS.md"];

/**
 * Teto default de arquivos por brief. Um PR grande (milhares de linhas) pode
 * concentrar centenas de arquivos em um único domínio; o teto mantém o contexto
 * do subagente limitado — o excedente vira "fora do orçamento" (cobertura
 * honesta), nunca some silenciosamente.
 */
export const DEFAULT_MAX_FILES_PER_BRIEF = 40;

/** Concorrência default das chamadas simultâneas ao Jev. */
export const DEFAULT_JEV_CONCURRENCY = 5;

/**
 * Localização default dos worktrees: dentro do workspace aberto no editor.
 * Mantém leitura/execução dentro da pasta do projeto — agentes com permissão
 * escopada ao workspace não pedem autorização a cada acesso.
 */
export const DEFAULT_WORKTREES_LOCATION = "workspace";

/** Teto default de bytes por arquivo no AST (evita bundles/minificados). */
export const DEFAULT_AST_MAX_FILE_BYTES = 512_000;

/** Teto default de arquivos candidatos na análise de impacto. */
export const DEFAULT_AST_MAX_IMPACT_FILES = 200;

/** Provider default da camada de IA (DeepSeek). */
export const DEFAULT_AI_PROVIDER = "deepseek" as const;

/** Modelo default da camada de IA. */
export const DEFAULT_AI_MODEL = "deepseek-v4-pro";

/** Concorrência default das chamadas de IA. */
export const DEFAULT_AI_CONCURRENCY = 2;

/** Passos default por agente (loop de tools + saída). */
export const DEFAULT_AI_MAX_STEPS = 12;

/** Timeout default de uma chamada de modelo (ms). */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/** Teto default de chamadas de IA por review. */
export const DEFAULT_AI_MAX_CALLS_PER_REVIEW = 40;

/** Teto default de tokens de saída por chamada. */
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 4096;
