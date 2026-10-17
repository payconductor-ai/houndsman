/**
 * Configuração do projeto (domínio) — resolve defaults e expõe o registry.
 *
 * Evita o "data clump" de passar `HoundsmanConfig` para dezenas de funções:
 * quem precisa de orçamento/concorrência/watchdogs pede aqui.
 * O contrato do consumidor (`houndsman.config.ts`) não muda.
 */

import type {
	AiProviderKind,
	HoundsmanAi,
	HoundsmanAiFeatures,
	HoundsmanAst,
	HoundsmanConfig,
	HoundsmanStorage,
} from "./config";
import {
	DEFAULT_AI_CONCURRENCY,
	DEFAULT_AI_MAX_CALLS_PER_REVIEW,
	DEFAULT_AI_MAX_OUTPUT_TOKENS,
	DEFAULT_AI_MAX_STEPS,
	DEFAULT_AI_MODEL,
	DEFAULT_AI_PROVIDER,
	DEFAULT_AI_TIMEOUT_MS,
	DEFAULT_ALWAYS_INCLUDE_DOCS,
	DEFAULT_AST_MAX_FILE_BYTES,
	DEFAULT_AST_MAX_IMPACT_FILES,
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAX_FILES_PER_BRIEF,
} from "./defaults";
import { WatchdogRegistry } from "./watchdog-registry";

/** Configuração resolvida do projeto. */
export class ProjectConfig<TId extends string = string> {
	readonly raw: HoundsmanConfig<TId>;
	readonly watchdogs: WatchdogRegistry<TId>;

	constructor(raw: HoundsmanConfig<TId>) {
		this.raw = raw;
		this.watchdogs = new WatchdogRegistry(raw);
	}

	get projectName(): string {
		return this.raw.projectName;
	}

	get storage(): HoundsmanStorage {
		return this.raw.storage ?? {};
	}

	/** Config do AST (objeto vazio quando ausente). */
	get ast(): HoundsmanAst {
		return this.raw.ast ?? {};
	}

	/** AST habilitado (default: ligado; falhas de grammar são fail-open). */
	get astEnabled(): boolean {
		return this.ast.enabled !== false;
	}

	get astMaxFileBytes(): number {
		const value = this.ast.maxFileBytes;
		return value !== undefined && value > 0 ? value : DEFAULT_AST_MAX_FILE_BYTES;
	}

	get astMaxImpactFiles(): number {
		const value = this.ast.maxImpactFiles;
		return value !== undefined && value >= 0 ? value : DEFAULT_AST_MAX_IMPACT_FILES;
	}

	get maxFilesPerBrief(): number {
		const value = this.raw.budgets?.maxFilesPerBrief;
		return value !== undefined && value > 0 ? value : DEFAULT_MAX_FILES_PER_BRIEF;
	}

	get jevConcurrency(): number {
		const value = this.raw.concurrency?.jev;
		return value !== undefined && value > 0 ? value : DEFAULT_JEV_CONCURRENCY;
	}

	get alwaysIncludeDocs(): readonly string[] {
		return this.raw.alwaysIncludeDocs ?? DEFAULT_ALWAYS_INCLUDE_DOCS;
	}

	get exclusions(): readonly RegExp[] {
		return this.raw.exclusions;
	}

	get docMappings(): readonly (readonly [RegExp, readonly string[]])[] {
		return this.raw.docMappings;
	}

	/** Config de IA (objeto vazio quando ausente). */
	get ai(): HoundsmanAi {
		return this.raw.ai ?? {};
	}

	/** IA habilitada (default: ligada; sem chave é fail-open). */
	get aiEnabled(): boolean {
		return this.ai.enabled !== false;
	}

	get aiProvider(): AiProviderKind {
		return this.ai.provider ?? DEFAULT_AI_PROVIDER;
	}

	get aiModel(): string {
		const value = this.ai.model?.trim();
		return value && value.length > 0 ? value : DEFAULT_AI_MODEL;
	}

	get aiConcurrency(): number {
		return positive(this.ai.concurrency, DEFAULT_AI_CONCURRENCY);
	}

	get aiMaxSteps(): number {
		return positive(this.ai.maxSteps, DEFAULT_AI_MAX_STEPS);
	}

	get aiMaxOutputTokens(): number {
		return positive(this.ai.maxOutputTokens, DEFAULT_AI_MAX_OUTPUT_TOKENS);
	}

	get aiTemperature(): number {
		const value = this.ai.temperature;
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	}

	get aiTimeoutMs(): number {
		return positive(this.ai.timeoutMs, DEFAULT_AI_TIMEOUT_MS);
	}

	get aiMaxCallsPerReview(): number {
		return positive(this.ai.maxCallsPerReview, DEFAULT_AI_MAX_CALLS_PER_REVIEW);
	}

	/** Teto de tokens por review (0/ausente = sem teto). */
	get aiMaxTokensPerReview(): number | undefined {
		const value = this.ai.maxTokensPerReview;
		return value !== undefined && value > 0 ? value : undefined;
	}

	/** Features resolvidas com defaults (`context`/`brief` ligadas). */
	get aiFeatures(): Required<HoundsmanAiFeatures> {
		const features = this.ai.features ?? {};
		return {
			context: features.context !== false,
			brief: features.brief !== false,
			classification: features.classification === true,
			preAnalysis: features.preAnalysis === true,
			verify: features.verify === true,
		};
	}

	/** Modelo efetivo de um watchdog (override por watchdog ou global). */
	aiModelFor(watchdogId: string): string {
		const override = this.ai.watchdogs?.[watchdogId]?.model?.trim();
		return override && override.length > 0 ? override : this.aiModel;
	}

	/** Passos efetivos de um watchdog (override por watchdog ou global). */
	aiMaxStepsFor(watchdogId: string): number {
		return positive(this.ai.watchdogs?.[watchdogId]?.maxSteps, this.aiMaxSteps);
	}

	/** Tokens de saída efetivos de um watchdog. */
	aiMaxOutputTokensFor(watchdogId: string): number {
		return positive(
			this.ai.watchdogs?.[watchdogId]?.maxOutputTokens,
			this.aiMaxOutputTokens,
		);
	}
}

/** Inteiro positivo ou o default. */
function positive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
