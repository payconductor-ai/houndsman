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

/** Teto default de bytes por arquivo no AST (evita bundles/minificados). */
export const DEFAULT_AST_MAX_FILE_BYTES = 512_000;

/** Teto default de arquivos candidatos na análise de impacto. */
export const DEFAULT_AST_MAX_IMPACT_FILES = 200;
