/**
 * Adapter do AI SDK (`generateText` + `Output.object`).
 *
 * O resto do motor depende só de `ModelProvider`; trocar de SDK é trocar este
 * arquivo. Timeout/cancelamento vêm do `AbortSignal`.
 */

import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import type { AiProviderKind } from "../config";
import { AiProviderError } from "./errors";
import { temperatureApplies } from "./provider-capabilities";
import {
	type AiUsage,
	emptyUsage,
	type ModelProvider,
	type ModelRequest,
	type ModelResponse,
} from "./types";

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

/** Argumentos aceitos por `generateText` (inclui `providerOptions` do SDK). */
type GenerateTextArgs = Parameters<typeof generateText>[0];

/**
 * Argumentos de `generateText` derivados do pedido (puro — testável sem rede).
 *
 * `temperature` só é enviada quando o provider de fato a aplica: em thinking
 * mode (DeepSeek V4 default) o AI SDK a descarta e emite warning por chamada.
 */
export function buildGenerateTextArgs<T>(
	model: LanguageModel,
	request: ModelRequest<T>,
	provider: AiProviderKind,
	modelId: string,
) {
	const providerOptions = request.providerOptions
		? (request.providerOptions as GenerateTextArgs["providerOptions"])
		: undefined;
	const temperature =
		request.temperature !== undefined &&
		temperatureApplies(provider, modelId, request.providerOptions)
			? request.temperature
			: undefined;
	return {
		model,
		system: request.instructions,
		prompt: request.prompt,
		...(request.outputSchema
			? { output: Output.object({ schema: request.outputSchema }) }
			: {}),
		...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
		...(providerOptions ? { providerOptions } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		maxRetries: 0,
	};
}

/** Provider de modelo apoiado no AI SDK. */
export class AiSdkModelProvider implements ModelProvider {
	constructor(
		readonly name: AiProviderKind,
		readonly modelId: string,
		private readonly model: LanguageModel,
	) {}

	async generate<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
		try {
			const result = await generateText({
				...buildGenerateTextArgs(this.model, request, this.name, this.modelId),
				...(request.signal ? { abortSignal: request.signal } : {}),
			});

			const output = request.outputSchema
				? (result.output as T)
				: ((result.text ?? "") as unknown as T);
			return {
				output,
				usage: mapUsage(result.usage),
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
