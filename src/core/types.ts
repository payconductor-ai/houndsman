/**
 * Tipos e constantes genéricas do motor de revisão (houndsman).
 *
 * Sem dependência do projeto: os ids de revisor são derivados do
 * `ReviewConfig` injetado pelo consumidor. `Severity` é a escala de achados;
 * `Rule` e `ReviewerMeta` descrevem as regras consumidas pela renderização.
 */

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
 * Regra do revisor: severidade + texto. O que "verificar" ou "evitar" é
 * implícito no texto da regra.
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
 * Entrada de classificação: como o revisor casa um arquivo alterado.
 *
 * `value` é sempre um padrão (regex, estilo grep — fonte sem barras).
 *
 * - `filename` (padrão) → padrão aplicado ao caminho do arquivo.
 * - `content`           → padrão aplicado ao conteúdo do arquivo.
 */
export type ClassifyRule = {
	type?: "filename" | "content";
	value: string;
};

export type ReviewerMeta = {
	/** Nome legível do revisor */
	name: string;
	/** Escopo de atuação (quais arquivos/pastas revisa) */
	scope: string;
	/** Arquivos que este revisor cobre (classificação). */
	classify?: readonly ClassifyRule[];
	/** Regras do revisor (verificar/evitar — implícito no texto). */
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

/** Contexto da PR injetado no brief (estrutural — sem dependência de runtime). */
export type ReviewerRenderContext = {
	objective?: string;
	motivation?: string;
	changeSummary?: string[];
};

/** Candidato pré-analisado (Jev) exibido no brief. */
export type ReviewerRenderCandidate = {
	file: string;
	severity: Severity;
	confidence: number;
	rule: string;
};

/** Dados que o renderer do brief recebe (sem dependência de runtime do jev/cli). */
export type ReviewerRenderArgs = {
	reviewerId: string;
	files: readonly string[];
	statuses: FileStatusMap;
	deleted: readonly string[];
	branch: string;
	outputPath: string;
	outputFormatPath: string;
	docs: readonly string[];
	context?: ReviewerRenderContext | null;
	candidates?: readonly ReviewerRenderCandidate[];
};

/** Definição completa de um revisor — 1 por arquivo em `project/reviewers/`. */
export type ReviewerDefinition = ReviewerMeta & {
	/** Id do revisor (deve casar com a chave em `REVIEWER_DEFINITIONS`). */
	id: string;
	/** Uma frase sobre o propósito (ex-`Objetivo` do .md). */
	description: string;
	/** Revisor deve checar breaking change em arquivos deletados do seu domínio. */
	breakingChange?: boolean;
	/** Prioridade de arquivos/paths (ex-`O Que Revisar`). Opcional. */
	reviewFocus?: readonly string[];
	/** O que NUNCA carregar/enviar (ex-`NÃO carregar`). Opcional. */
	exclude?: readonly string[];
	/** Render customizado do brief; se omitido usa `defaultRenderBrief`.
	 *  Recebe a própria definição (`def`) para reutilizar `defaultRenderBrief`
	 *  sem criar dependência de runtime `registry → core`. */
	renderBrief?: (args: ReviewerRenderArgs, def: ReviewerDefinition) => string[];
};

/** Helper de autoria: tipa o objeto do revisor (id contra `ReviewerId`). */
export function defineReviewer(def: ReviewerDefinition): ReviewerDefinition {
	return def;
}

/** Índice numérico da severidade (menor = mais grave). */
export function severityRank(severity: Severity): number {
	return SEVERITY_ORDER.indexOf(severity);
}
