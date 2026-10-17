/**
 * Prompt do estado ORIENT.
 */

import type { AgentContext } from "../../agent/agent-context";

/** Pede hipóteses iniciais (sem achados). */
export function orientPrompt(context: AgentContext): string {
	return [
		`Oriente a revisão do watchdog '${context.watchdog.name}'.`,
		"Liste hipóteses de violação que precisam ser investigadas.",
		"Use as regras e o delta AST fornecidos. Não emita findings neste estado.",
		"Produza JSON com `hypotheses`.",
	].join("\n");
}
