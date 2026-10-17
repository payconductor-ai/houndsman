/**
 * Contratos genéricos da camada de IA (biblioteca).
 *
 * `core/ai` não conhece o harness: expõe modelo, uso, tools e resultado. O
 * harness nativo (`src/harness/`) consome estes contratos.
 */

import type { ZodType, ZodTypeAny } from "zod";
import type { AiProviderKind } from "../config";

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

/** Tool exposta ao modelo (execução já vinculada a um contexto). */
export type AiTool = {
	name: string;
	description: string;
	inputSchema: ZodTypeAny;
	execute(input: unknown): Promise<string>;
};

/** Pedido de geração de modelo (texto ou objeto estruturado). */
export type ModelRequest<T> = {
	/** Instruções de sistema. */
	instructions?: string;
	/** Prompt do usuário. */
	prompt: string;
	/** Tools disponíveis para o loop do modelo. */
	tools?: Record<string, AiTool>;
	/** Schema de saída (quando ausente, a saída é texto). */
	outputSchema?: ZodType<T>;
	maxSteps?: number;
	maxOutputTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
};

/** Resposta do modelo. */
export type ModelResponse<T> = {
	output: T;
	usage: AiUsage;
	steps: number;
	finishReason: string;
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
