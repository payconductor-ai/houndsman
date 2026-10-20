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
import { temperatureApplies } from "./provider-capabilities";
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
	const tools = request.tools ? toToolSet(request.tools) : undefined;
	const hasTools = tools !== undefined && Object.keys(tools).length > 0;
	const maxSteps = request.maxSteps ?? 1;
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
		...(hasTools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
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
