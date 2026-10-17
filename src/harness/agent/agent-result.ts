/**
 * Resultado de um agente (watchdog).
 */

import type { AiUsage } from "../../core/ai";
import type { WatchdogReport } from "../../core/report-builder";

/** Resultado da execução de um watchdog. */
export type AgentResult = {
	watchdogId: string;
	status: "done" | "skipped" | "failed";
	report?: WatchdogReport;
	usage: AiUsage;
	error?: string;
	reason?: string;
};
