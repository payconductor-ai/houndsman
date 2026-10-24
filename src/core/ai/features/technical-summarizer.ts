/**
 * Pontos técnicos estruturais via IA (fallback ao builder determinístico).
 */

import {
	buildTechnicalPromptPayload,
	parseTechnicalSummary,
	type TechnicalPromptInput,
	type TechnicalSummary,
} from "../../technical-summary";
import type { AiClient } from "../ai-client";
import { technicalInstructions, technicalPrompt } from "../prompts/technical";
import { type TechnicalSummaryPlan, TechnicalSummarySchema } from "../schemas";

/** Resume a estrutura da mudança em destaques curtos. */
export class AiTechnicalSummarizer {
	constructor(private readonly client: AiClient) {}

	/** `true` quando a feature está ligada e há IA disponível. */
	get enabled(): boolean {
		return this.client.available && this.client.features.technical;
	}

	/** Falha-aberto: sem IA ou saída inválida → `null`. */
	async summarize(input: TechnicalPromptInput): Promise<TechnicalSummary | null> {
		if (!this.enabled) return null;
		const result = await this.client.generateObject<TechnicalSummaryPlan>(
			"technical",
			{
				instructions: technicalInstructions(),
				prompt: technicalPrompt(buildTechnicalPromptPayload(input)),
				outputSchema: TechnicalSummarySchema,
			},
		);
		if (!result.ok) return null;
		return parseTechnicalSummary({
			...result.output,
			source: "ai",
			headSha: input.headSha,
		});
	}
}
