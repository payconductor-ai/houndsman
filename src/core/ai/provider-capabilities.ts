/**
 * Capacidades do provider de IA (puro).
 *
 * O AI SDK descarta `temperature`/`topP` e emite warning a cada chamada quando
 * o DeepSeek opera em thinking mode — que é o default nos modelos V4. Enviar o
 * parâmetro nesse caso não tem efeito: o adapter o omite.
 */

import type { AiProviderKind, AiProviderOptions } from "../config";

/** `true` quando o modelo DeepSeek usa thinking sem `providerOptions`. */
function isDeepSeekV4Model(modelId: string): boolean {
	return !/(^|[/.])deepseek-(?:chat|reasoner|v[1-3](?:\.\d+)?)(?=[-/:.]|$)/.test(
		modelId,
	);
}

/**
 * `true` quando o DeepSeek vai operar em thinking mode.
 *
 * Espelha a resolução do `@ai-sdk/deepseek`: `thinking.type` explícito manda;
 * sem ele, V4 (e o alias `deepseek-reasoner`) ligam thinking.
 */
export function deepSeekThinkingEnabled(
	modelId: string,
	providerOptions: AiProviderOptions | undefined,
): boolean {
	const thinking = providerOptions?.deepseek?.thinking as
		| Record<string, unknown>
		| undefined;
	const type = thinking?.type;
	if (type === "disabled") return false;
	if (type === "enabled" || type === "adaptive") return true;
	return modelId === "deepseek-reasoner" || isDeepSeekV4Model(modelId);
}

/** `true` quando `temperature` chega ao provider (não é descartada). */
export function temperatureApplies(
	provider: AiProviderKind,
	modelId: string,
	providerOptions?: AiProviderOptions,
): boolean {
	if (provider !== "deepseek") return true;
	return !deepSeekThinkingEnabled(modelId, providerOptions);
}
