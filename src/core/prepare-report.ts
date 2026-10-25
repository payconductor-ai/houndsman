/**
 * Relatório de duração do `prepare` (artefato `prepare-report.json`).
 *
 * O CLI já imprime cada etapa; o artefato permite comparar runs (antes/depois
 * de tuning) sem poluir o `manifest.json`, que é determinístico nos snapshots.
 */

import type { AiUsage } from "./ai/types";
import type { PrepareStage } from "./orchestrator";

/** Duração de uma etapa do prepare. */
export type PrepareStageTiming = {
	stage: PrepareStage;
	durationMs: number;
};

/** Chamada de IA que falhou (timeout, truncamento, schema inválido). */
export type PrepareAiFailure = {
	feature: string;
	model: string;
	durationMs: number;
	error: string;
	finishReason?: string;
};

/** Uso de IA do prepare: tokens das chamadas boas + tentativas/falhas. */
export type PrepareAiReport = AiUsage & {
	attempts: number;
	failures: readonly PrepareAiFailure[];
};

/** Entrada do relatório. */
export type PrepareReportInput = {
	/** Início do prepare (ISO). */
	startedAt: string;
	durationMs: number;
	stages: readonly PrepareStageTiming[];
	/** Uso agregado de IA e falhas (quando configurada). */
	ai?: PrepareAiReport;
};

/** Monta o objeto persistido. */
export function buildPrepareReport(input: PrepareReportInput) {
	return {
		version: 1 as const,
		startedAt: input.startedAt,
		durationMs: input.durationMs,
		stages: input.stages.map((item) => ({ ...item })),
		ai: input.ai
			? {
					...input.ai,
					failures: input.ai.failures.map((failure) => ({ ...failure })),
				}
			: null,
	};
}

/** Serializa o relatório (JSON indentado + newline). */
export function renderPrepareReport(input: PrepareReportInput): string {
	return `${JSON.stringify(buildPrepareReport(input), null, 2)}\n`;
}
