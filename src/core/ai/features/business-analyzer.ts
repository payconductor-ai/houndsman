/**
 * Hipóteses de lógica/domínio via IA (`AiBusinessAnalyzer`).
 *
 * Produz **candidatos** para o revisor `general` confirmar ou refutar — nunca
 * achados. Serve para dar cobertura a PRs maiores que o orçamento do brief.
 */

import { GENERAL_WATCHDOG_ID } from "../../builtins";
import type { BusinessInput, BusinessSummary } from "../../business-summary";
import { buildBusinessPromptPayload } from "../../business-summary";
import type { JevCandidate } from "../../jev";
import type { AiClient } from "../ai-client";
import {
	businessAnalysisInstructions,
	businessAnalysisPrompt,
} from "../prompts/business";
import { BusinessHypothesesSchema, type BusinessHypothesis } from "../schemas";

/** Confiança mínima para a hipótese virar candidato. */
const MIN_CONFIDENCE = 0.5;

/** Gera hipóteses de fluxo para o watchdog `general`. */
export class AiBusinessAnalyzer {
	constructor(private readonly client: AiClient) {}

	/** `true` quando a feature está ligada e há IA disponível. */
	get enabled(): boolean {
		return this.client.available && this.client.features.business;
	}

	/** Candidatos validados contra os arquivos do escopo. */
	async analyze(input: {
		business: BusinessSummary;
		payload: BusinessInput;
	}): Promise<JevCandidate[]> {
		if (!this.enabled) return [];
		const files = new Set(Object.keys(input.payload.classification.files));
		const result = await this.client.generateObject<{
			hypotheses: BusinessHypothesis[];
		}>("business-analysis", {
			instructions: businessAnalysisInstructions(),
			prompt: businessAnalysisPrompt(
				input.business,
				buildBusinessPromptPayload(input.payload),
			),
			outputSchema: BusinessHypothesesSchema,
			maxOutputTokens: 1_200,
		});
		if (!result.ok) return [];
		return result.output.hypotheses
			.filter((item) => files.has(item.file) && item.confidence >= MIN_CONFIDENCE)
			.map((item, index) => ({
				watchdogId: GENERAL_WATCHDOG_ID,
				rule: `${item.kind === "domain" ? "Domínio" : "Lógica"}: ${item.statement}`,
				severity: "attention" as const,
				file: item.file,
				confidence: item.confidence,
				questionKey: `business-${index}`,
			}));
	}
}
