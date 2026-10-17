/**
 * Scheduler de agentes — concorrência limitada (default 2).
 */

import type { AgentContext } from "./agent-context";
import type { AgentReporter } from "./agent-reporter";
import type { AgentRunner } from "./agent-runner";
import type { ReviewAgentOutcome } from "./review-agent";

/** Executa agentes com concorrência limitada. */
export class AgentScheduler {
	constructor(
		private readonly runner: AgentRunner,
		private readonly concurrency: number,
		private readonly reporter?: AgentReporter,
	) {}

	/** Executa todos os contextos e devolve os resultados na ordem original. */
	async run(contexts: readonly AgentContext[]): Promise<ReviewAgentOutcome[]> {
		const results = new Array<ReviewAgentOutcome>(contexts.length);
		let cursor = 0;
		const workers = Math.max(1, Math.min(this.concurrency, contexts.length));

		const worker = async (): Promise<void> => {
			while (cursor < contexts.length) {
				const index = cursor++;
				const context = contexts[index];
				if (!context) return;
				this.reporter?.progress(`[${context.watchdog.id}] investigando...`);
				results[index] = await this.runner.run(context);
			}
		};

		await Promise.all(Array.from({ length: workers }, () => worker()));
		return results;
	}
}
