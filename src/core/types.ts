/**
 * Tipos e constantes genéricas do motor de revisão (houndsman).
 *
 * Sem dependência do projeto: os ids de watchdog são derivados do
 * `HoundsmanConfig` injetado pelo consumidor. `Severity` é a escala de achados;
 * `Rule` e `WatchdogMeta` descrevem as regras consumidas pela renderização.
 */

import type { BriefPlan } from "./ai/schemas";
import type { AstFileBrief } from "./ast/types";
import type { BusinessSummary } from "./business-summary";
import type { ChangedScope } from "./changed-scope";
import type { JevRuleSpec } from "./jev/jev-types";

/** Severidade de um achado. `blocking` bloqueia o merge. */
export type Severity = "blocking" | "attention" | "suggestion" | "nit";

/** Ordem canônica de severidade (mais grave primeiro). */
export const SEVERITY_ORDER: readonly Severity[] = [
	"blocking",
	"attention",
	"suggestion",
	"nit",
];

/** Emoji associado a cada severidade. */
export const SEVERITY_EMOJI: Record<Severity, string> = {
	blocking: "❌",
	attention: "⚠️",
	suggestion: "💡",
	nit: "🔎",
};

/**
 * Regra do watchdog: severidade + texto. O texto declara a polaridade de forma
 * explícita — `Promover:` (algo que DEVE acontecer) ou `Evitar:`/`Não`/`Nunca`
 * (algo que NÃO DEVE acontecer).
 *
 * `jev` (opcional) é a spec de pré-análise: quando presente, a regra vira uma
 * pergunta tipada enviada ao modelo no Passo 1.5.
 */
export type Rule = {
	severity: Severity;
	text: string;
	jev?: JevRuleSpec;
};

/**
 * Entrada de classificação: como o watchdog casa um arquivo alterado.
 *
 * `value` é sempre um padrão (regex, estilo grep — fonte sem barras).
 *
 * - `filename` (padrão) → padrão aplicado ao caminho do arquivo.
 * - `content`           → padrão aplicado ao conteúdo do arquivo.
 * - `symbol`            → padrão aplicado aos nomes de símbolos (AST).
 * - `import`            → padrão aplicado às fontes/nomes de imports (AST).
 * - `export`            → padrão aplicado aos nomes exportados (AST).
 * - `decorator`         → padrão aplicado aos decorators (AST).
 *
 * Regras AST exigem grammar disponível; sem ela, a regra simplesmente não casa.
 */
export type ClassifyRule = {
	type?: "filename" | "content" | "symbol" | "import" | "export" | "decorator";
	value: string;
};

export type WatchdogMeta = {
	/** Nome legível do watchdog */
	name: string;
	/** Escopo de atuação (quais arquivos/pastas revisa) */
	scope: string;
	/** Arquivos que este watchdog cobre (classificação). */
	classify?: readonly ClassifyRule[];
	/** Regras do watchdog (texto com polaridade explícita: `Promover:`/`Evitar:`). */
	rules: readonly Rule[];
	/** Arquivos de documentação de contexto (caminhos relativos à raiz) */
	contextFiles: string[];
};

/** Status de um arquivo alterado (git `--name-status`). */
export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "unknown";

/** Status por arquivo, conforme o `classification.json`. */
export type FileStatusMap = Record<string, { status: FileStatus; oldPath?: string }>;

/** Linhas adicionadas/removidas de um arquivo no diff (churn). */
export type FileChurn = { additions: number; deletions: number };

/** Churn por caminho de arquivo (chave = caminho novo). */
export type ChurnMap = Record<string, FileChurn>;

/** Contexto da PR injetado no brief (estrutural — sem dependência de runtime). */
export type WatchdogRenderContext = {
	objective?: string;
	motivation?: string;
	changeSummary?: string[];
};

/** Candidato pré-analisado (Jev) exibido no brief. */
export type WatchdogRenderCandidate = {
	file: string;
	severity: Severity;
	confidence: number;
	rule: string;
};

/** Dados que o renderer do brief recebe (sem dependência de runtime do jev/cli). */
export type WatchdogRenderArgs = {
	watchdogId: string;
	files: readonly string[];
	statuses: FileStatusMap;
	/** Churn por arquivo — insumo para priorizar a leitura (PRs grandes). */
	churn?: ChurnMap;
	/** Arquivos do domínio fora do orçamento — NÃO revisar (registrar em `skipped`). */
	overflow?: readonly string[];
	deleted: readonly string[];
	branch: string;
	outputPath: string;
	outputFormatPath: string;
	/** Worktree onde a review roda (ausente = clone principal). */
	worktree?: string;
	docs: readonly string[];
	context?: WatchdogRenderContext | null;
	candidates?: readonly WatchdogRenderCandidate[];
	/** Estrutura/delta dos arquivos selecionados (AST). */
	ast?: readonly AstFileBrief[];
	/** Plano de revisão sugerido por IA (nunca substitui as regras). */
	aiPlan?: BriefPlan;
	/** Modelo de intenção da PR (negócio) — insumo do revisor `general`. */
	business?: BusinessSummary;
	/** Caminho do `business-summary.json` no staging (versão canônica). */
	businessSummaryPath?: string;
	/** Trechos alterados (`diff` por arquivo) — só para o revisor de fluxo. */
	snippets?: readonly { file: string; snippet: string }[];
	/** `true` no revisor de fluxo: exige devolver/gravar o modelo de intenção. */
	flowReview?: boolean;
	/** Escopo do diff por arquivo (símbolos alterados; hunks como fallback). */
	changedScope?: ChangedScope;
	/** Micro-alterações iguais em muitos arquivos (propagação mecânica). */
	propagation?: PropagationCluster | null;
	/** Contratos alterados cujos importadores não mudaram (possível lacuna). */
	propagationGaps?: readonly PropagationGap[];
};

/** Cluster de propagação mecânica (ex.: novo parâmetro em 100 call sites). */
export type PropagationCluster = {
	/** Linhas adicionadas normalizadas (o padrão dominante). */
	lines: string[];
	/** Arquivos que seguem o padrão. */
	files: string[];
	/** Arquivos com micro-alteração que NÃO seguem o padrão. */
	outliers: { file: string; lines: string[] }[];
};

/** Contrato que mudou e tem importadores fora do diff. */
export type PropagationGap = {
	/** Arquivo do contrato (o que mudou). */
	file: string;
	/** Importadores que não aparecem no diff. */
	importers: string[];
};

/** Definição completa de um watchdog — 1 por arquivo em `project/watchdogs/`. */
export type WatchdogDefinition = WatchdogMeta & {
	/** Id do watchdog (deve casar com a chave em `WATCHDOG_DEFINITIONS`). */
	id: string;
	/** Uma frase sobre o propósito (ex-`Objetivo` do .md). */
	description: string;
	/** Watchdog deve checar breaking change em arquivos deletados do seu domínio. */
	breakingChange?: boolean;
	/**
	 * Watchdog de último recurso: só assume arquivos que nenhum outro casou.
	 * Útil para padrões gerais/lógica; `classify` é ignorado.
	 */
	fallback?: boolean;
	/**
	 * Permite findings emergentes (`Lógica:`/`Domínio:`) fora das regras
	 * explícitas. Exige evidência e severidade máxima `attention`.
	 */
	allowEmergentFindings?: boolean;
	/** Prioridade de arquivos/paths (ex-`O Que Revisar`). Opcional. */
	reviewFocus?: readonly string[];
	/** O que NUNCA carregar/enviar (ex-`NÃO carregar`). Opcional. */
	exclude?: readonly string[];
	/** Render customizado do brief; se omitido usa `defaultRenderBrief`.
	 *  Recebe a própria definição (`def`) para reutilizar `defaultRenderBrief`
	 *  sem criar dependência de runtime `registry → core`. */
	renderBrief?: (args: WatchdogRenderArgs, def: WatchdogDefinition) => string[];
};

/** Helper de autoria: tipa o objeto do watchdog (id contra `WatchdogId`). */
export function defineWatchdog(def: WatchdogDefinition): WatchdogDefinition {
	return def;
}

/** Índice numérico da severidade (menor = mais grave). */
export function severityRank(severity: Severity): number {
	return SEVERITY_ORDER.indexOf(severity);
}
