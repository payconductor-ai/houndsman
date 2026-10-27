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
export const DEFAULT_AI_MODEL = "deepseek-flash";

/**
 * Concorrência default das chamadas de IA do prepare.
 *
 * Vale principalmente para os planos de brief (1 chamada por watchdog): com 4,
 * 8 watchdogs fecham em 2 rodadas em vez de 4.
 */
export const DEFAULT_AI_CONCURRENCY = 4;

/** Timeout default de uma chamada de modelo (ms). */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/** Teto default de chamadas de IA por review. */
export const DEFAULT_AI_MAX_CALLS_PER_REVIEW = 40;

/**
 * Processos maki simultâneos no harness local (`houndsman hunt`).
 *
 * 8 = uma onda para os watchdogs usuais (domínios + `general`), em vez de 2.
 */
export const DEFAULT_HUNT_CONCURRENCY = 8;

/** Timeout default de um watchdog no harness local (15 min). */
export const DEFAULT_HUNT_TIMEOUT_MS = 900_000;

/**
 * Trechos alterados injetados no brief (watchdog de domínio).
 *
 * Substituem a leitura do arquivo inteiro: o subagente começa pelo diff e só
 * abre o arquivo para contexto adjacente. O orçamento é distribuído entre os
 * arquivos (metade em partes iguais, o resto por churn) — antes, os primeiros
 * arquivos consumiam o teto e o subagente lia os demais à mão.
 */
export const DEFAULT_BRIEF_SNIPPET_CHARS = 24_000;
export const DEFAULT_BRIEF_SNIPPET_CHARS_PER_FILE = 4_000;

/** Mesmos limites para o revisor de fluxo (`general`), que vê todos os arquivos. */
export const GENERAL_BRIEF_SNIPPET_CHARS = 32_000;
export const GENERAL_BRIEF_SNIPPET_CHARS_PER_FILE = 5_000;

/** Fração do teto dividida igualmente entre os arquivos (o resto vai por churn). */
export const BRIEF_SNIPPET_FLOOR_RATIO = 0.5;

/** Piso de chars por arquivo no rateio igual (evita trechos inúteis). */
export const BRIEF_SNIPPET_MIN_PER_FILE = 120;

/**
 * A partir daqui o `general` revisa por **fluxo** em vez de amostrar arquivos.
 *
 * Em PRs grandes, 40 arquivos com ~800 chars cada viram amostragem: melhor ver
 * os arquivos que participam dos fluxos do modelo de intenção (com diff de
 * verdade) e declarar o resto em `skipped`.
 */
export const GENERAL_FLOW_MIN_FILES = 40;
export const GENERAL_FLOW_MIN_LINES = 2_000;

/** Arquivos do recorte de fluxo do `general`. */
export const GENERAL_FLOW_MAX_FILES = 15;

/** Diff por arquivo no recorte de fluxo — profundidade em vez de cobertura. */
export const GENERAL_FLOW_SNIPPET_CHARS_PER_FILE = 2_000;

/** Retentativas default quando a saída do watchdog é inválida. */
export const DEFAULT_HUNT_RETRIES = 1;

/**
 * Versão do maki fixada pelo houndsman. O binário é baixado por
 * `houndsman hunt install`; `HOUNDSMAN_MAKI_VERSION` sobrescreve.
 */
export const DEFAULT_MAKI_VERSION = "0.6.5";
