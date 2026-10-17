/**
 * Resultado do `hunt`.
 */

import type { AiUsage } from "../../core/ai";
import type { AgentResult } from "../agent/agent-result";

/** Status final da execução. */
export type HuntResult = {
	status: "completed" | "partial" | "dry-run" | "failed";
	reviewId: string;
	blockers: number;
	attention: number;
	watchdogs: AgentResult[];
	usage: AiUsage;
	messages: string[];
};
