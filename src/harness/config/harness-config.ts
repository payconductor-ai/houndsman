/**
 * Configuração resolvida do harness nativo.
 *
 * O harness **não** reimplementa defaults: consome o `ProjectConfig` do motor e
 * aplica apenas overrides de execução (`hunt --model`, `--max-calls`, etc.).
 */

import type { AiProviderKind, AiProviderOptions } from "../../core/config";
import { ProjectConfig } from "../../core/project-config";

/** Overrides de execução do harness. */
export type HarnessOverrides = {
	provider?: AiProviderKind;
	model?: string;
	concurrency?: number;
	maxSteps?: number;
	maxCalls?: number;
};

/** Configuração resolvida (imutável para o agente). */
export class HarnessConfig {
	readonly project: ProjectConfig;
	private readonly overrides: HarnessOverrides;

	constructor(project: ProjectConfig, overrides: HarnessOverrides = {}) {
		this.project = project;
		this.overrides = overrides;
	}

	/** `ProjectConfig` com os overrides aplicados (usado pelo `AiClient`). */
	withOverrides(): ProjectConfig {
		const provider = this.overrides.provider ?? this.project.aiProvider;
		const model = this.overrides.model?.trim() || this.project.aiModel;
		return new ProjectConfig({
			...this.project.raw,
			ai: { ...this.project.raw.ai, provider, model },
		});
	}

	get provider(): AiProviderKind {
		return this.overrides.provider ?? this.project.aiProvider;
	}

	get model(): string {
		return this.overrides.model?.trim() || this.project.aiModel;
	}

	modelFor(watchdogId: string): string {
		return this.overrides.model?.trim() || this.project.aiModelFor(watchdogId);
	}

	maxStepsFor(watchdogId: string): number {
		return positive(this.overrides.maxSteps, this.project.aiMaxStepsFor(watchdogId));
	}

	maxOutputTokensFor(watchdogId: string): number {
		return this.project.aiMaxOutputTokensFor(watchdogId);
	}

	get concurrency(): number {
		return positive(this.overrides.concurrency, this.project.aiConcurrency);
	}

	get maxCalls(): number {
		return positive(this.overrides.maxCalls, this.project.aiMaxCallsPerReview);
	}

	get maxTokens(): number | undefined {
		return this.project.aiMaxTokensPerReview;
	}

	get timeoutMs(): number {
		return this.project.aiTimeoutMs;
	}

	get temperature(): number {
		return this.project.aiTemperature;
	}

	/** Opções do AI SDK por provider (config do projeto, sem override de flag). */
	get providerOptions(): AiProviderOptions | undefined {
		return this.project.aiProviderOptions;
	}
}

/** Inteiro positivo ou o default. */
function positive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
