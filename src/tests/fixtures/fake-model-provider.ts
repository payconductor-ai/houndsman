/**
 * Provider de modelo fake — suíte sem rede.
 */

import type { AiUsage, ModelProvider, ModelRequest, ModelResponse } from "../../core/ai";

/** Uso padrão de uma chamada fake. */
export function fakeUsage(calls = 1): AiUsage {
	return {
		inputTokens: 10 * calls,
		outputTokens: 5 * calls,
		totalTokens: 15 * calls,
		calls,
	};
}

/** Handler roteirizado: recebe o request e o índice da chamada. */
export type FakeHandler = (
	request: ModelRequest<unknown>,
	index: number,
) => unknown | Promise<unknown>;

/** Provider roteirizado. */
export class FakeModelProvider implements ModelProvider {
	readonly name = "deepseek" as const;
	readonly modelId: string;
	readonly requests: ModelRequest<unknown>[] = [];
	calls = 0;

	constructor(
		private readonly handler: FakeHandler,
		modelId = "fake-model",
	) {
		this.modelId = modelId;
	}

	async generate<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
		this.requests.push(request as ModelRequest<unknown>);
		const index = this.calls++;
		const output = await this.handler(request as ModelRequest<unknown>, index);
		return {
			output: output as T,
			usage: fakeUsage(),
			finishReason: "stop",
		};
	}
}
