/**
 * Tipos de investigação (harness nativo).
 *
 * Uma revisão é uma investigação: regras viram tarefas, tarefas produzem
 * evidências, e só drafts com evidência válida viram findings.
 */

import type { Severity } from "../../core/types";
import type { ToolCapability } from "../tools/agent-tool";

/** Tipo de tarefa investigável. */
export type InvestigationTaskKind =
	| "rule-evidence"
	| "symbol-impact"
	| "tests"
	| "context";

/** Tarefa de investigação derivada de uma regra. */
export type InvestigationTask = {
	id: string;
	rule: string;
	severity: Severity;
	kind: InvestigationTaskKind;
	files: string[];
	symbols: string[];
	capabilities: ToolCapability[];
	/** Prioridade (menor = antes). */
	priority: number;
	status: "pending" | "in_progress" | "done" | "skipped";
	reason?: string;
};

/** Plano completo de um agente. */
export type InvestigationPlan = {
	tasks: InvestigationTask[];
	totalFiles: number;
	estimatedToolCalls: number;
};

/** Estratégia substituível de planejamento. */
export interface InvestigationStrategy {
	plan(
		context: {
			watchdogId: string;
			files: readonly string[];
			symbols: readonly string[];
		},
		rules: readonly import("./rule-analyzer").RuleAnalysis[],
	): InvestigationPlan;
}

/** Evidência coletada por uma tool. */
export type EvidenceKind =
	| "definition"
	| "reference"
	| "import"
	| "diff"
	| "test"
	| "doc";

/** Trecho de código/docs que sustenta uma conclusão. */
export type Evidence = {
	id: string;
	file: string;
	startLine: number;
	endLine: number;
	snippet: string;
	kind: EvidenceKind;
	sourceTool: string;
	confidence: number;
};

/** Status de cobertura de uma regra. */
export type RuleCoverageStatus = "checked" | "not_applicable" | "skipped";

/** Cobertura de uma regra (toda regra precisa terminar aqui). */
export type RuleCoverage = {
	rule: string;
	status: RuleCoverageStatus;
	files: string[];
	symbols: string[];
	reason?: string;
};

/** Achado proposto pelo agente (ainda não é finding final). */
export type FindingDraft = {
	rule: string;
	severity: Severity;
	file: string;
	line?: number;
	message: string;
	action: string;
	evidenceIds: string[];
	confidence: number;
};

/** Decisão do crítico sobre um draft. */
export type CriticVerdict = "keep" | "drop" | "downgrade";

/** Resultado do crítico. */
export type CriticDecision = {
	draft: FindingDraft;
	verdict: CriticVerdict;
	reason: string;
};

/** Gera o id de uma evidência (determinístico por ordem de coleta). */
export function evidenceId(sequence: number): string {
	return `ev-${String(sequence).padStart(3, "0")}`;
}
