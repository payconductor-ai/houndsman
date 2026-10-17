/**
 * Factory de modelos (`core/ai`).
 *
 * Resolve provider/modelo da configuração e cria o adapter do AI SDK. Só o
 * DeepSeek tem credencial própria no houndsman
 * (`HOUNDSMAN_DEEP_SEEK_API_KEY`, lida em `core/env.ts`). Providers extras
 * exigem que o pacote seja instalado e ficam atrás da mesma interface.
 */

import type { LanguageModel } from "ai";
import type { AiProviderKind } from "../config";
import { env } from "../env";
import type { ProjectConfig } from "../project-config";
import { AiSdkModelProvider } from "./ai-sdk-model-provider";
import { AiConfigurationError } from "./errors";
import type { ModelProvider } from "./types";

/** `true` quando o provider tem credencial disponível. */
export function hasProviderCredential(provider: AiProviderKind): boolean {
	switch (provider) {
		case "deepseek":
			return Boolean(env.deepSeekApiKey);
		case "openai":
			return Boolean(env.openAiApiKey);
		case "anthropic":
			return Boolean(env.anthropicApiKey);
		default:
			return false;
	}
}

/** Factory com cache por provider/modelo. */
export class ModelFactory {
	private readonly project: ProjectConfig;
	private readonly cache = new Map<string, ModelProvider>();

	constructor(project: ProjectConfig) {
		this.project = project;
	}

	get provider(): AiProviderKind {
		return this.project.aiProvider;
	}

	get modelId(): string {
		return this.project.aiModel;
	}

	/** `true` quando há provider + credencial. */
	get isConfigured(): boolean {
		return this.project.aiEnabled && hasProviderCredential(this.provider);
	}

	/** Cria (ou recupera do cache) o provider de modelo. */
	async create(overrides: { model?: string } = {}): Promise<ModelProvider> {
		const modelId = overrides.model?.trim() || this.modelId;
		const key = `${this.provider}:${modelId}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		if (!this.project.aiEnabled) {
			throw new AiConfigurationError(
				"IA desabilitada na configuração (`ai.enabled: false`).",
			);
		}
		const languageModel = await this.languageModel(modelId);
		const provider = new AiSdkModelProvider(this.provider, modelId, languageModel);
		this.cache.set(key, provider);
		return provider;
	}

	/**
	 * Providers opcionais: o pacote não é dependência do houndsman. Importamos
	 * por nome dinâmico para que o typecheck não exija a instalação.
	 */
	private async extraProvider(
		pkg: string,
		factoryName: string,
		modelId: string,
		apiKey: string | undefined,
	): Promise<LanguageModel> {
		const mod = (await import(pkg).catch(() => null)) as Record<
			string,
			unknown
		> | null;
		const factory = mod?.[factoryName];
		if (typeof factory !== "function") {
			throw new AiConfigurationError(
				`Provider '${this.provider}' requer o pacote ${pkg} instalado.`,
			);
		}
		const config = this.project.ai;
		const provider = factory({
			...(apiKey ? { apiKey } : {}),
			...(config.baseURL ? { baseURL: config.baseURL } : {}),
		});
		return provider(modelId) as LanguageModel;
	}

	/** Resolve o `LanguageModel` do AI SDK por provider. */
	private async languageModel(modelId: string): Promise<LanguageModel> {
		const config = this.project.ai;
		switch (this.provider) {
			case "deepseek": {
				if (!env.deepSeekApiKey) {
					throw new AiConfigurationError(
						"HOUNDSMAN_DEEP_SEEK_API_KEY não configurada — IA indisponível.",
					);
				}
				const { createDeepSeek } = await import("@ai-sdk/deepseek");
				const provider = createDeepSeek({
					apiKey: env.deepSeekApiKey,
					...(config.baseURL ? { baseURL: config.baseURL } : {}),
				});
				return provider(modelId);
			}
			case "openai":
				return this.extraProvider(
					"@ai-sdk/openai",
					"createOpenAI",
					modelId,
					env.openAiApiKey,
				);
			case "anthropic":
				return this.extraProvider(
					"@ai-sdk/anthropic",
					"createAnthropic",
					modelId,
					env.anthropicApiKey,
				);
			default:
				throw new AiConfigurationError(
					`Provider de IA desconhecido: ${this.provider}.`,
				);
		}
	}
}
