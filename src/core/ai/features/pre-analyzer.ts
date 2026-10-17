/**
 * Pré-análise por IA (substitui o Jev quando a feature está ligada).
 *
 * Produz candidatos no mesmo shape do Jev — nunca bloqueiam a revisão.
 */

import type { JevCandidate } from "../../jev";
import type { AiClient } from "../ai-client";
import {
	type PreAnalysisPromptInput,
	preAnalysisInstructions,
	preAnalysisPrompt,
} from "../prompts/pre-analysis";
import { type AiCandidate, CandidateSchema } from "../schemas";

/** Gera candidatos de pré-análise para um watchdog. */
export class AiPreAnalyzer {
	constructor(private readonly client: AiClient) {}

	get enabled(): boolean {
		return this.client.available && this.client.features.preAnalysis;
	}

	/** Candidatos validados contra as regras e arquivos fornecidos. */
	async analyze(input: PreAnalysisPromptInput): Promise<JevCandidate[]> {
		if (!this.enabled || input.files.length === 0) return [];
		const rules = new Set(input.rules.map((rule) => rule.text.trim()));
		const files = new Set(input.files.map((item) => item.file));
		const result = await this.client.generateObject<{ candidates: AiCandidate[] }>(
			"pre-analysis",
			{
				instructions: preAnalysisInstructions(),
				prompt: preAnalysisPrompt(input),
				outputSchema: CandidateSchema,
				maxSteps: 1,
			},
			this.client.projectConfig.aiModelFor(input.watchdogId),
		);
		if (!result.ok) return [];
		return result.output.candidates
			.filter((item) => files.has(item.file) && rules.has(item.rule.trim()))
			.map((item) => ({
				watchdogId: input.watchdogId,
				rule: item.rule,
				severity: item.severity,
				file: item.file,
				confidence: item.confidence,
				questionKey: "ai",
			}));
	}
}
