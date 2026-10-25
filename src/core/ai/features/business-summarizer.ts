/**
 * Modelo de intenção via IA (`AiBusinessSummarizer`).
 *
 * Fail-open: sem IA/chave/feature a feature fica desligada e o prepare mantém o
 * modelo determinístico. A saída é validada por schema — nada de texto solto.
 */

import {
	type BusinessInput,
	type BusinessSummary,
	buildBusinessPromptPayload,
	parseBusinessSummary,
} from "../../business-summary";
import type { AiClient } from "../ai-client";
import { businessInstructions, businessPrompt } from "../prompts/business";
import { type BusinessSummaryPlan, BusinessSummarySchema } from "../schemas";

/** Reconstrói a intenção da PR a partir do diff. */
export class AiBusinessSummarizer {
	constructor(private readonly client: AiClient) {}

	/** `true` quando a feature está ligada e há IA disponível. */
	get enabled(): boolean {
		return this.client.available && this.client.features.business;
	}

	/** Falha-aberto: sem IA ou saída inválida → `null`. */
	async summarize(input: BusinessInput): Promise<BusinessSummary | null> {
		if (!this.enabled) return null;
		const result = await this.client.generateObject<BusinessSummaryPlan>("business", {
			instructions: businessInstructions(),
			prompt: businessPrompt(buildBusinessPromptPayload(input)),
			outputSchema: BusinessSummarySchema,
			// Schema permite 12 fluxos/12 contratos: 1.400 truncava com thinking ligado.
			maxOutputTokens: 2_000,
		});
		if (!result.ok) return null;
		return parseBusinessSummary(
			{ ...result.output, source: "ai", headSha: input.headSha },
			"ai",
			input.headSha,
		);
	}
}
