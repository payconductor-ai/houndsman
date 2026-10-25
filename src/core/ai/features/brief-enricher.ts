/**
 * Enriquecimento de briefs via IA (`AiBriefEnricher`).
 *
 * Uma chamada por watchdog, concorrência limitada. A saída é um plano sugerido
 * (`BriefPlan`) — nunca cria regra nem achado. Falha → brief inalterado.
 */

import type { AiClient } from "../ai-client";
import { type BriefPromptInput, briefInstructions, briefPrompt } from "../prompts/brief";
import { type BriefPlan, BriefPlanSchema } from "../schemas";

/** Enriquecimento de briefs (fail-open por watchdog). */
export class AiBriefEnricher {
	constructor(private readonly client: AiClient) {}

	/** `true` quando a feature está ligada e há IA disponível. */
	get enabled(): boolean {
		return this.client.available && this.client.features.brief;
	}

	/** Plano de um watchdog; `null` em falha. */
	async enrich(input: BriefPromptInput): Promise<BriefPlan | null> {
		if (!this.enabled) return null;
		const result = await this.client.generateObject<BriefPlan>(
			"brief",
			{
				instructions: briefInstructions(),
				prompt: briefPrompt(input),
				outputSchema: BriefPlanSchema,
				maxOutputTokens: 1_400,
			},
			this.client.projectConfig.aiModelFor(input.watchdogId),
		);
		if (!result.ok) return null;
		return result.output;
	}

	/** Enriquece vários watchdogs com concorrência limitada. */
	async enrichAll(
		inputs: readonly BriefPromptInput[],
	): Promise<Map<string, BriefPlan>> {
		const plans = new Map<string, BriefPlan>();
		if (!this.enabled || inputs.length === 0) return plans;
		const concurrency = Math.max(1, this.client.projectConfig.aiConcurrency);
		let cursor = 0;

		const worker = async (): Promise<void> => {
			while (cursor < inputs.length) {
				const input = inputs[cursor++];
				if (!input) return;
				const plan = await this.enrich(input);
				if (plan) plans.set(input.watchdogId, plan);
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()),
		);
		return plans;
	}
}
