/**
 * Fachada de IA (`core/ai`) — fail-open, budget e uso.
 *
 * As features do core usam `generateObject`/`generateText` e tratam `ok:false`
 * como "sem IA": a revisão determinística segue idêntica.
 */

import type { ZodType } from "zod";
import type { AiProviderOptions } from "../config";
import type { ProjectConfig } from "../project-config";
import { AiConfigurationError, errorMessage } from "./errors";
import { ModelFactory } from "./model-factory";
import type { AiResult, AiUsage, ModelProvider, ModelRequest } from "./types";
import { AiUsageBudget } from "./usage-budget";
import { AiUsageRecorder } from "./usage-recorder";

/** Opções de construção do cliente. */
export type AiClientOptions = {
	project: ProjectConfig;
	/** Provider injetado (testes) — dispensa chave/rede. */
	provider?: ModelProvider | null;
	factory?: ModelFactory;
	recorder?: AiUsageRecorder;
	budget?: AiUsageBudget;
};

/** Pedido de objeto estruturado. */
export type ObjectRequest<T> = {
	instructions?: string;
	prompt: string;
	outputSchema: ZodType<T>;
	maxOutputTokens?: number;
	temperature?: number;
	/** Opções do AI SDK por provider (mescladas com a config do projeto). */
	providerOptions?: AiProviderOptions;
	signal?: AbortSignal;
};

/** Pedido de texto livre. */
export type TextRequest = Omit<ObjectRequest<string>, "outputSchema">;

/** Resultado da validação de credencial (doctor). */
export type AiCredentialCheck = {
	ok: boolean;
	kind: "ok" | "missing" | "invalid" | "unreachable";
	detail: string;
	model?: string;
};

/** Cliente de IA compartilhado pela review. */
export class AiClient {
	private readonly project: ProjectConfig;
	private readonly factory: ModelFactory;
	private readonly override: ModelProvider | null | undefined;
	readonly recorder: AiUsageRecorder;
	readonly budget: AiUsageBudget;

	constructor(options: AiClientOptions) {
		this.project = options.project;
		this.factory = options.factory ?? new ModelFactory(options.project);
		this.override = options.provider;
		this.recorder =
			options.recorder ??
			new AiUsageRecorder(this.project.aiProvider, this.project.aiModel);
		this.budget =
			options.budget ??
			new AiUsageBudget({
				maxCalls: this.project.aiMaxCallsPerReview,
				maxTokens: this.project.aiMaxTokensPerReview,
			});
	}

	get modelId(): string {
		return this.project.aiModel;
	}

	/** Configuração resolvida do projeto (features, budgets). */
	get projectConfig(): ProjectConfig {
		return this.project;
	}

	/** Features resolvidas (context/brief ligadas por default). */
	get features() {
		return this.project.aiFeatures;
	}

	/** `true` quando há provider disponível (injetado ou configurado + chave). */
	get available(): boolean {
		if (this.override !== undefined) return this.override !== null;
		return this.factory.isConfigured;
	}

	/** Provider obrigatório (lança quando a IA não está configurada). */
	async requireProvider(model?: string): Promise<ModelProvider> {
		if (this.override === null) {
			throw new AiConfigurationError(
				"IA indisponível: provider injetado como null.",
			);
		}
		if (this.override) return this.override;
		return this.factory.create({ model });
	}

	/** Geração de objeto estruturado, fail-open. */
	async generateObject<T>(
		feature: string,
		request: ObjectRequest<T>,
		model?: string,
	): Promise<AiResult<T>> {
		return this.run(
			feature,
			{ ...request, outputSchema: request.outputSchema },
			model,
		);
	}

	/** Geração de texto, fail-open. */
	async generateText(
		feature: string,
		request: TextRequest,
		model?: string,
	): Promise<AiResult<string>> {
		return this.run<string>(feature, { ...request }, model);
	}

	/**
	 * Ping mínimo para o `doctor`: valida a credencial sem gastar tokens
	 * relevantes. Não lança; devolve o diagnóstico.
	 */
	async validateCredential(
		options: { timeoutMs?: number } = {},
	): Promise<AiCredentialCheck> {
		if (this.override === null || !this.available) {
			return {
				ok: false,
				kind: "missing",
				detail: "provider/chave de IA não configurados",
			};
		}
		const timeoutMs = Math.max(
			1_000,
			options.timeoutMs ?? Math.min(this.project.aiTimeoutMs, 8_000),
		);
		const result = await this.generateText("doctor-ping", {
			prompt: "Responda apenas OK.",
			maxOutputTokens: 4,
			temperature: 0,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (result.ok) {
			return {
				ok: true,
				kind: "ok",
				detail: "credencial válida",
				model: result.model,
			};
		}
		const message = result.error ?? "falha desconhecida";
		if (
			/401|403|unauthorized|invalid.*(key|token)|authentication|api.?key/i.test(
				message,
			)
		) {
			return { ok: false, kind: "invalid", detail: message };
		}
		return { ok: false, kind: "unreachable", detail: message };
	}

	/** Executa a chamada respeitando budget, timeout e uso. */
	private async run<T>(
		feature: string,
		request: Omit<ObjectRequest<T>, "outputSchema"> & {
			outputSchema?: ZodType<T>;
		},
		model?: string,
	): Promise<AiResult<T>> {
		if (!this.available) {
			return { ok: false, error: "IA não configurada (fail-open)." };
		}
		try {
			this.budget.assertCanCall();
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}

		try {
			const provider = await this.requireProvider(model);
			const response = await provider.generate({
				...request,
				providerOptions: mergeProviderOptions(
					this.project.aiProviderOptions,
					request.providerOptions,
				),
				signal: combineSignals(request.signal, this.project.aiTimeoutMs),
			});
			this.budget.record(response.usage);
			this.recorder.record(feature, provider.modelId, response.usage);
			return {
				ok: true,
				output: response.output,
				usage: response.usage,
				model: provider.modelId,
			};
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
}

/** Mescla opções por provider (o override do chamador vence chave a chave). */
function mergeProviderOptions(
	base: AiProviderOptions | undefined,
	override: AiProviderOptions | undefined,
): AiProviderOptions | undefined {
	if (!base) return override;
	if (!override) return base;
	const merged: AiProviderOptions = { ...base };
	for (const [provider, values] of Object.entries(override)) {
		merged[provider] = { ...base[provider], ...values };
	}
	return merged;
}

/** Combina o sinal do chamador com o timeout configurado. */
function combineSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal | undefined {
	const timeout =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? AbortSignal.timeout(timeoutMs)
			: undefined;
	if (!signal) return timeout;
	if (!timeout) return signal;
	return AbortSignal.any([signal, timeout]);
}

export type { AiUsage, ModelRequest };
