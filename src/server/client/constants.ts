/**
 * Constantes de apresentação do cliente (labels, ordem, emojis).
 */

import type { Decision, ExecState, RunStatus, RunSummary, Severity } from "./types";

export const SEVERITY_EMOJI: Record<Severity, string> = {
	blocking: "❌",
	attention: "⚠️",
	suggestion: "💡",
	nit: "🔎",
};

export const SEVERITY_ORDER: Severity[] = ["blocking", "attention", "suggestion", "nit"];

export const DECISIONS: Decision[] = ["pending", "execute", "ignore"];

export const DECISION_LABELS: Record<Decision, string> = {
	pending: "Pendente",
	execute: "Executar",
	ignore: "Ignorar",
};

export const EXEC_STATES: ExecState[] = ["pending", "in_progress", "done", "stale"];

export const EXEC_LABELS: Record<ExecState, string> = {
	pending: "exec: pendente",
	in_progress: "exec: em andamento",
	done: "exec: feito",
	stale: "exec: stale",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
	reviewing: "Revisando",
	review_done: "Revisão pronta",
	fixing: "Corrigindo",
	fix_done: "Correção pronta",
};

/** Limiar de inatividade para exibir timeout (display-only; não é status). */
export const STATUS_TIMEOUT_MS = 10 * 60 * 1000;

export type RunStatusView = { kind: string; label: string; timeout: boolean };

/** View do status de uma run — label; vira timeout quando ativo e sem ping recente. */
export function describeRunStatus(
	run: RunSummary,
	now: number = Date.now(),
): RunStatusView | null {
	const status = run.status;
	if (!status) return null;
	const active = status === "reviewing" || status === "fixing";
	const updated = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
	if (active && Number.isFinite(updated) && now - updated > STATUS_TIMEOUT_MS) {
		return {
			kind: "timeout",
			label: status === "reviewing" ? "Timeout na revisão" : "Timeout na correção",
			timeout: true,
		};
	}
	return { kind: status, label: RUN_STATUS_LABELS[status], timeout: false };
}

/** Artefatos que podem ser lidos na aba "Artefatos". */
export const ARTIFACTS = [
	"manifest.json",
	"classification.json",
	"candidates.json",
	"context-summary.json",
	"review.md",
] as const;

export type ArtifactName = (typeof ARTIFACTS)[number];

/** Descrição de cada artefato (mostrada ao selecioná-lo na aba). */
export const ARTIFACT_INFO: Record<ArtifactName, string> = {
	"manifest.json":
		"Resumo da execução: watchdogs ativos, arquivos, orçamento, churn, Jev e contexto da PR.",
	"classification.json":
		"Classificação do diff: watchdogs ativados por arquivo, status (A/M/D/R) e churn por arquivo.",
	"candidates.json":
		"Indícios da pré-análise Jev (regra + arquivo + confiança) — não são achados.",
	"context-summary.json":
		"Resumo da PR (objetivo, motivação e alterações) gerado no Passo 0.",
	"review.md": "Relatório consolidado da revisão — o entregável.",
};

/** Legenda única de cada aba (explica o que a aba é; mostrada quando selecionada). */
export const TAB_CAPTIONS = {
	findings:
		"Triagem dos achados da revisão: decida Executar, Ignorar ou deixe Pendente — o comentário orienta o auto-fix. Agente: houndsman findings list --decision pending --json · findings done <id>.",
	artifacts:
		"Artefatos brutos da run: manifesto, classificação, candidatos Jev, contexto da PR e o relatório consolidado (review.md).",
} as const;
