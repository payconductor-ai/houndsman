/**
 * Resolução do modelo/credencial do maki (harness local).
 *
 * O houndsman reaproveita a config de IA (`ai.provider`/`ai.model`) e a env já
 * preenchida (`HOUNDSMAN_DEEP_SEEK_API_KEY` etc.). O maki lê o nome nativo do
 * provider (`DEEPSEEK_API_KEY`); a chave é injetada só no processo filho.
 */

import type { AiProviderKind } from "../config";
import { ENV_NAMES, env } from "../env";
import type { ProjectConfig } from "../project-config";

/** Modelo e credencial no formato esperado pelo maki. */
export type MakiModel = {
	/** Spec `provider/model-id` passada em `--model`. */
	spec: string;
	provider: AiProviderKind;
	/** Variável nativa que o maki lê (ex.: `DEEPSEEK_API_KEY`). */
	apiKeyEnv: string;
	/** Chave do houndsman (pode faltar; `requireMakiModel` exige). */
	apiKey?: string;
};

/** Env nativa do maki por provider. */
export const MAKI_API_KEY_ENV: Record<AiProviderKind, string> = {
	deepseek: "DEEPSEEK_API_KEY",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
};

/** Chave do houndsman por provider (para mensagens acionáveis). */
const HOUNDSMAN_KEY_ENV: Record<AiProviderKind, string> = {
	deepseek: ENV_NAMES.deepSeekApiKey,
	openai: ENV_NAMES.openAiApiKey,
	anthropic: ENV_NAMES.anthropicApiKey,
};

/** Nome da env do houndsman que guarda a chave do provider. */
export function houndsmanKeyEnvFor(provider: AiProviderKind): string {
	return HOUNDSMAN_KEY_ENV[provider];
}

/** `true` para um slug de provider suportado. */
function isAiProvider(value: string): value is AiProviderKind {
	return value === "deepseek" || value === "openai" || value === "anthropic";
}

/** Chave do houndsman para o provider. */
function providerKey(provider: AiProviderKind): string | undefined {
	switch (provider) {
		case "deepseek":
			return env.deepSeekApiKey;
		case "openai":
			return env.openAiApiKey;
		case "anthropic":
			return env.anthropicApiKey;
		default:
			return undefined;
	}
}

/**
 * Resolve o modelo: override → `hunt.model` → `ai.model`.
 *
 * Um prefixo reconhecido (`openai/...`, `anthropic/...`) troca o provider do
 * harness e, junto, a variável de credencial usada.
 */
export function resolveMakiModel(project: ProjectConfig, override?: string): MakiModel {
	const configured = override?.trim() || project.huntModel;
	let provider = project.aiProvider;
	let modelId = configured;

	const [prefix, ...tail] = configured.split("/");
	if (tail.length > 0 && isAiProvider(prefix)) {
		provider = prefix;
		modelId = tail.join("/");
	}

	const spec = `${provider}/${modelId}`;
	return {
		spec,
		provider,
		apiKeyEnv: MAKI_API_KEY_ENV[provider],
		apiKey: providerKey(provider),
	};
}

/** Como `resolveMakiModel`, mas lança quando a credencial falta. */
export function requireMakiModel(
	project: ProjectConfig,
	override?: string,
): MakiModel & { apiKey: string } {
	const model = resolveMakiModel(project, override);
	if (!model.apiKey) {
		throw new Error(
			`Harness local sem credencial: defina ${HOUNDSMAN_KEY_ENV[model.provider]} ` +
				`(o maki usa ${model.apiKeyEnv}).`,
		);
	}
	return { ...model, apiKey: model.apiKey };
}
