/**
 * Visão de tools por agente (registry + policy + middleware).
 *
 * O agente pede `toModelTools(state)` e recebe apenas o que pode usar naquele
 * estado, já com cache/budget/redaction aplicados.
 */

import type { AiTool } from "../../core/ai";
import type { ToolContext } from "./tool-context";
import type { ToolMiddleware } from "./tool-middleware";
import type { AgentStateName, ToolPolicy } from "./tool-policy";
import type { ToolRegistry } from "./tool-registry";

/** Fachada por agente. */
export class Toolbox {
	constructor(
		readonly registry: ToolRegistry,
		readonly policy: ToolPolicy,
		readonly middleware: ToolMiddleware,
	) {}

	/** Tools permitidas no estado, no formato do modelo. */
	toModelTools(state: AgentStateName, context: ToolContext): Record<string, AiTool> {
		return this.registry.toModelTools(this.policy, state, context, this.middleware);
	}

	/** Descrição das tools permitidas (prompt). */
	describe(state: AgentStateName): string {
		return this.registry.describeForPrompt(this.policy, state);
	}

	/** Executa uma tool fora do modelo (testes/uso determinístico). */
	execute(name: string, input: unknown, context: ToolContext, state: AgentStateName) {
		return this.registry.execute(name, input, context, this.middleware, state);
	}
}
