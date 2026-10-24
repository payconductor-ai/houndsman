/**
 * Verificação de findings por IA (casos ambíguos do `verify`).
 *
 * Retorna `id → confiança` para o `applyConfidence` do core. Falha-aberto:
 * ids ausentes mantêm o provisório local.
 */

import type { AiClient } from "../ai-client";
import {
	type VerifyPromptInput,
	verifyInstructions,
	verifyPrompt,
} from "../prompts/verify";
import { type AiVerdict, VerifySchema } from "../schemas";

/** Confirma/refuta findings ambíguos. */
export class AiVerifier {
	constructor(private readonly client: AiClient) {}

	get enabled(): boolean {
		return this.client.available && this.client.features.verify;
	}

	/** Mapa id → confiança (0–1) de persistência. */
	async verify(input: VerifyPromptInput): Promise<Map<string, number>> {
		const confidence = new Map<string, number>();
		if (!this.enabled || input.findings.length === 0) return confidence;
		const ids = new Set(input.findings.map((item) => item.id));
		const result = await this.client.generateObject<{ verdicts: AiVerdict[] }>(
			"verify",
			{
				instructions: verifyInstructions(),
				prompt: verifyPrompt(input),
				outputSchema: VerifySchema,
			},
		);
		if (!result.ok) return confidence;
		for (const verdict of result.output.verdicts) {
			if (!ids.has(verdict.id)) continue;
			confidence.set(verdict.id, verdict.persisting ? verdict.confidence : 0);
		}
		return confidence;
	}
}
