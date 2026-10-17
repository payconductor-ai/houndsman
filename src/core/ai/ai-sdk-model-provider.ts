/**
 * Adapter do AI SDK (`generateText` + `Output.object` + tools).
 *
 * O resto do motor depende só de `ModelProvider`; trocar de SDK é trocar este
 * arquivo. O loop de tools é do SDK (`stepCountIs`), com timeout/cancelamento
 * via `AbortSignal`.
 */

import type { LanguageModel, ToolSet } from "ai";
import { generateText, Output, stepCountIs, tool } from "ai";
import type { AiProviderKind } from "../config";
import { AiProviderError } from "./errors";
import {
	type AiTool,
	type AiUsage,
	emptyUsage,
	type ModelProvider,
	type ModelRequest,
	type ModelResponse,
} from "./types";

/** Converte as tools do motor para o formato do AI SDK. */
function toToolSet(tools: Record<string, AiTool>): ToolSet {
	const entries = Object.entries(tools).map(([name, item]) => [
		name,
		tool({
			description: item.description,
			inputSchema: item.inputSchema,
			execute: async (input: unknown) => item.execute(input),
		}),
	]);
	return Object.fromEntries(entries) as ToolSet;
}

/** Mapeia o uso do SDK de forma defensiva (campos opcionais por provider). */
export function mapUsage(raw: unknown): AiUsage {
	const usage = (raw ?? {}) as Record<string, unknown>;
	const input = numberOrZero(usage.inputTokens ?? usage.promptTokens);
	const output = numberOrZero(usage.outputTokens ?? usage.completionTokens);
	const total = numberOrZero(usage.totalTokens) || input + output;
	return { inputTokens: input, outputTokens: output, totalTokens: total, calls: 1 };
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Provider de modelo apoiado no AI SDK. */
export class AiSdkModelProvider implements ModelProvider {
	constructor(
		readonly name: AiProviderKind,
		readonly modelId: string,
		private readonly model: LanguageModel,
	) {}

	async generate<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
		const tools = request.tools ? toToolSet(request.tools) : undefined;
		const hasTools = tools !== undefined && Object.keys(tools).length > 0;
		const maxSteps = request.maxSteps ?? 1;

		try {
			const result = await generateText({
				model: this.model,
				system: request.instructions,
				prompt: request.prompt,
				...(hasTools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
				...(request.outputSchema
					? { output: Output.object({ schema: request.outputSchema }) }
					: {}),
				...(request.maxOutputTokens
					? { maxOutputTokens: request.maxOutputTokens }
					: {}),
				...(request.temperature !== undefined
					? { temperature: request.temperature }
					: {}),
				...(request.signal ? { abortSignal: request.signal } : {}),
				maxRetries: 0,
			});

			const output = request.outputSchema
				? (result.output as T)
				: ((result.text ?? "") as unknown as T);
			return {
				output,
				usage: mapUsage(result.usage),
				steps: result.steps?.length ?? 1,
				finishReason: result.finishReason ?? "unknown",
			};
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new AiProviderError("Chamada de IA cancelada ou expirada.", error);
			}
			throw new AiProviderError(
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
	}
}

export { emptyUsage };
