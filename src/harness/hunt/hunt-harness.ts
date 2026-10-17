/**
 * Composition root do harness nativo (`houndsman hunt`).
 */

import { AiUsageRecorder, ModelFactory, type ModelProvider } from "../../core/ai";
import { AiConfigurationError } from "../../core/ai/errors";
import type { HoundsmanEngine } from "../../core/engine/houndsman-engine";
import { logger as defaultLogger, type LoggerLike } from "../../core/logging";
import { type AgentReporter, LoggerReporter } from "../agent/agent-reporter";
import { HarnessConfig } from "../config/harness-config";
import type { HuntOptions } from "./hunt-options";
import type { HuntResult } from "./hunt-result";
import { HuntSession } from "./hunt-session";

/** Orquestrador do hunt nativo. */
export class HuntHarness {
	private constructor(
		private readonly engine: HoundsmanEngine,
		private readonly options: HuntOptions,
		private readonly reporter: AgentReporter,
		private readonly logger: LoggerLike,
		private readonly config: HarnessConfig,
		private readonly provider?: ModelProvider,
	) {}

	/**
	 * Monta o harness: resolve provider/model (overrides das flags) e cria o
	 * provider quando não é dry-run. `--provider`/`--model` sobrescrevem a config.
	 */
	static async from(
		engine: HoundsmanEngine,
		options: HuntOptions,
		logger: LoggerLike = defaultLogger,
		providerOverride?: ModelProvider,
	): Promise<HuntHarness> {
		const config = new HarnessConfig(engine.project, {
			provider: options.provider,
			model: options.model,
			concurrency: options.concurrency,
			maxCalls: options.maxCalls,
		});
		const reporter = new LoggerReporter(logger);
		if (options.dryRun) {
			return new HuntHarness(engine, options, reporter, logger, config);
		}
		if (providerOverride) {
			return new HuntHarness(
				engine,
				options,
				reporter,
				logger,
				config,
				providerOverride,
			);
		}
		const factory = new ModelFactory(config.withOverrides());
		try {
			const provider = await factory.create();
			return new HuntHarness(engine, options, reporter, logger, config, provider);
		} catch (error) {
			if (error instanceof AiConfigurationError) {
				throw new Error(
					`hunt exige IA configurada: ${error.message} Use --dry-run para inspecionar o plano.`,
				);
			}
			throw error;
		}
	}

	/** Executa o hunt. */
	async run(): Promise<HuntResult> {
		const recorder = new AiUsageRecorder(this.config.provider, this.config.model);
		return new HuntSession({
			engine: this.engine,
			options: this.options,
			config: this.config,
			reporter: this.reporter,
			logger: this.logger,
			provider: this.provider,
			recorder,
		}).run();
	}
}
