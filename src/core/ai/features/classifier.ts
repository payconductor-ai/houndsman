/**
 * Classificação fallback por IA (arquivos que nenhum watchdog casou).
 */

import type { AiClient } from "../ai-client";
import {
	classificationInstructions,
	classificationPrompt,
} from "../prompts/classification";
import { type AiClassification, ClassificationSchema } from "../schemas";

/** Atribui arquivos não classificados a watchdogs conhecidos. */
export class AiClassifier {
	constructor(private readonly client: AiClient) {}

	get enabled(): boolean {
		return this.client.available && this.client.features.classification;
	}

	/**
	 * Devolve `arquivo → watchdogId` apenas para ids válidos. Arquivos sem
	 * atribuição simplesmente continuam não classificados.
	 */
	async classify(
		files: readonly string[],
		watchdogs: readonly { id: string; name: string; scope: string }[],
	): Promise<Map<string, string>> {
		const assignments = new Map<string, string>();
		if (!this.enabled || files.length === 0 || watchdogs.length === 0) {
			return assignments;
		}
		const known = new Set(watchdogs.map((item) => item.id));
		const filesSet = new Set(files);
		const result = await this.client.generateObject<AiClassification>(
			"classification",
			{
				instructions: classificationInstructions(),
				prompt: classificationPrompt({ files, watchdogs }),
				outputSchema: ClassificationSchema,
				maxSteps: 1,
			},
		);
		if (!result.ok) return assignments;
		for (const item of result.output.assignments) {
			if (!known.has(item.watchdogId) || !filesSet.has(item.file)) continue;
			assignments.set(item.file, item.watchdogId);
		}
		return assignments;
	}
}
