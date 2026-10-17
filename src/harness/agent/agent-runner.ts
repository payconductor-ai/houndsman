/**
 * Executor de um agente — retry curto para falhas transitórias.
 *
 * 429/5xx/timeout são tentados uma vez mais; 4xx não. O resultado é sempre
 * estruturado (`failed` com motivo), nunca uma exceção solta.
 */

import type { AgentContext } from "./agent-context";
import type { AgentFactory } from "./agent-factory";
import type { AgentResult } from "./agent-result";
import type { ReviewAgentOutcome } from "./review-agent";

/** Executor com retry. */
export class AgentRunner {
	constructor(private readonly factory: AgentFactory) {}

	/** Executa um agente (com uma retentativa em falha transitória). */
	async run(context: AgentContext): Promise<ReviewAgentOutcome> {
		const first = await this.factory.create(context).run();
		if (first.status !== "failed" || !isTransient(first.error)) return first;
		const second = await this.factory.create(context).run();
		return second;
	}
}

/** Erro transitório (rate limit, 5xx, timeout). */
function isTransient(message: string | undefined): boolean {
	if (!message) return false;
	return /429|5\d\d|timeout|temporar|ECONNRESET|ETIMEDOUT|abort/i.test(message);
}

export type { AgentResult };
