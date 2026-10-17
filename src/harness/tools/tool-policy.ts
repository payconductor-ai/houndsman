/**
 * Política de tools por estado do agente.
 *
 * O modelo só vê as tools permitidas no estado atual. Adicionar uma tool não
 * exige alterar o agente — basta declarar capabilities compatíveis.
 */

import type { ToolCapability, ToolMetadata } from "./agent-tool";

/** Estados da máquina de investigação. */
export type AgentStateName = "ORIENT" | "PLAN" | "INVESTIGATE" | "VERIFY" | "CONCLUDE";

/** Capabilities liberadas por estado. */
const DEFAULT_POLICY: Record<AgentStateName, readonly ToolCapability[]> = {
	ORIENT: ["read", "outline", "ast", "impact", "rules", "symbol"],
	PLAN: ["rules", "symbol", "impact", "ast"],
	INVESTIGATE: [
		"read",
		"search",
		"outline",
		"symbol",
		"references",
		"ast",
		"impact",
		"rules",
		"tests",
		"docs",
	],
	VERIFY: ["symbol", "references", "search", "read"],
	CONCLUDE: [],
};

/** Política substituível. */
export class ToolPolicy {
	private readonly policy: Record<AgentStateName, readonly ToolCapability[]>;

	constructor(policy: Partial<Record<AgentStateName, readonly ToolCapability[]>> = {}) {
		this.policy = { ...DEFAULT_POLICY, ...policy };
	}

	/** Capabilities liberadas no estado. */
	capabilities(state: AgentStateName): readonly ToolCapability[] {
		return this.policy[state];
	}

	/** `true` se a tool pode ser usada no estado. */
	allows(state: AgentStateName, metadata: ToolMetadata): boolean {
		const allowed = this.policy[state];
		return metadata.capabilities.some((capability) => allowed.includes(capability));
	}
}
