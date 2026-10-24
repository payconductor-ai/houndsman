/**
 * Contratos genéricos da camada de IA (biblioteca).
 *
 * Expõe modelo, uso e resultado; as features do core são as únicas consumidoras.
 */

import type { ZodType } from "zod";
import type { AiProviderKind, AiProviderOptions } from "../config";

/** Uso de tokens de uma chamada (ou acumulado de uma review). */
export type AiUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	calls: number;
};

/** Uso zerado (novo objeto — nunca compartilhe para mutação). */
export function emptyUsage(): AiUsage {
	return { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
}

/** Soma dois usos sem mutar os originais. */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		calls: a.calls + b.calls,
	};
}

/** Pedido de geração de modelo (texto ou objeto estruturado). */
export type ModelRequest<T> = {
	/** Instruções de sistema. */
	instructions?: string;
	/** Prompt do usuário. */
	prompt: string;
	/** Schema de saída (quando ausente, a saída é texto). */
	outputSchema?: ZodType<T>;
	maxOutputTokens?: number;
	temperature?: number;
	/** Opções do AI SDK por provider (repassadas ao SDK sem interpretação). */
	providerOptions?: AiProviderOptions;
	signal?: AbortSignal;
};

/** Resposta do modelo. */
export type ModelResponse<T> = {
	output: T;
	usage: AiUsage;
	finishReason: string;
	/** Avisos do provider já normalizados em texto (ex.: modo de compatibilidade). */
	warnings?: string[];
};

/** Provider de modelo (adaptador do AI SDK ou fake nos testes). */
export interface ModelProvider {
	readonly name: AiProviderKind;
	readonly modelId: string;
	generate<T>(request: ModelRequest<T>): Promise<ModelResponse<T>>;
}

/** Resultado fail-open de uma chamada de IA. */
export type AiResult<T> =
	| { ok: true; output: T; usage: AiUsage; model: string }
	| { ok: false; error: string; usage?: AiUsage };
