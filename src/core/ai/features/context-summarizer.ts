/**
 * Resumo do contexto da PR via IA (fallback ao subagente de contexto).
 */

import { type ContextSummary, parseContextSummary } from "../../report-builder";
import type { AiClient } from "../ai-client";
import { contextInstructions, contextPrompt } from "../prompts/context";
import { type ContextSummaryPlan, ContextSummarySchema } from "../schemas";

/** Resume `context.json` em um `ContextSummary` curto. */
export class AiContextSummarizer {
	constructor(private readonly client: AiClient) {}

	/** `true` quando a feature está ligada e há IA disponível. */
	get enabled(): boolean {
		return this.client.available && this.client.features.context;
	}

	/** Falha-aberto: sem IA ou saída inválida → `null`. */
	async summarize(raw: string): Promise<ContextSummary | null> {
		if (!this.enabled) return null;
		const result = await this.client.generateObject<ContextSummaryPlan>("context", {
			instructions: contextInstructions(),
			prompt: contextPrompt(raw),
			outputSchema: ContextSummarySchema,
			maxSteps: 1,
		});
		if (!result.ok) return null;
		return parseContextSummary({ ...result.output, available: true });
	}
}
