/** Comando `doctor` (alias `check`) — valida config, ambiente e credenciais. */

import type { AiClient } from "../../core/ai/ai-client";
import { ArgParser } from "../../core/arg-parser";
import type { AiProviderKind } from "../../core/config";
import { ENV_NAMES, env } from "../../core/env";
import { checkRegistry } from "../../core/registry-check";
import { storageLocation } from "../../core/storage/paths";
import type { CliContext, Command } from "./command";

/** Chave de ambiente esperada por provider. */
function keyFor(provider: AiProviderKind): string | undefined {
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

/** Nome da variável de ambiente por provider. */
function envNameFor(provider: AiProviderKind): string {
	switch (provider) {
		case "openai":
			return ENV_NAMES.openAiApiKey;
		case "anthropic":
			return ENV_NAMES.anthropicApiKey;
		default:
			return ENV_NAMES.deepSeekApiKey;
	}
}

export class DoctorCommand implements Command {
	readonly name = "doctor";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		const noPing = parser.has("--no-ping");
		const engine = await context.engine();
		const { logger } = context;

		logger.step("Validando configuração do projeto...");
		const { problems, warnings, jevQuestions } = checkRegistry(engine.config);

		if (problems.length > 0) {
			logger.error("Problemas na configuração de revisão:");
			for (const problem of problems) logger.error(`  - ${problem}`);
			return 1;
		}
		logger.success(
			`${engine.config.watchdogIds.length} watchdogs, ${jevQuestions} pergunta(s) Jev.`,
		);

		if (warnings.length > 0) {
			logger.warn(`${warnings.length} aviso(s) (não bloqueantes):`);
			for (const warning of warnings) logger.bullet(warning);
		}

		logger.step("Ambiente:");
		logger.bullet(`${Bun.which("git") ? "✅" : "❌"} git`);
		logger.bullet(`${Bun.which("gh") ? "✅" : "⚠️ "} gh (opcional — contexto da PR)`);
		const ast = await engine.ast.check();
		logger.bullet(`${ast.ok ? "✅" : "⚠️ "} AST: ${ast.detail}`);

		const provider = engine.ai.projectConfig.aiProvider;
		const key = keyFor(provider);
		logger.bullet(
			`${key ? "✅" : "⚠️ "} ${envNameFor(provider)} (provider ${provider})`,
		);
		logger.bullet(
			`IA: provider=${provider}, model=${engine.ai.modelId}, ` +
				`disponível=${engine.ai.available ? "sim" : "não"}`,
		);

		await this.reportAiCredential(context, engine.ai, provider, key, noPing);
		await this.reportJevCredential(context, noPing);

		logger.step("Persistência:");
		logger.bullet(`provider: ${engine.storage.kind}`);
		logger.bullet(storageLocation(engine.config));
		logger.bullet(`repo: ${engine.repo.key}`);
		return 0;
	}

	/**
	 * Valida a credencial do provider de IA com um ping mínimo. Fail-open:
	 * problemas de credencial são diagnóstico e não alteram o exit code.
	 */
	private async reportAiCredential(
		context: CliContext,
		ai: AiClient,
		provider: AiProviderKind,
		key: string | undefined,
		noPing: boolean,
	): Promise<void> {
		if (!key) {
			context.logger.warn(
				`IA: ${provider} sem credencial — features de IA ficam fail-open.`,
			);
			return;
		}
		if (noPing) {
			context.logger.info("IA: validação pulada (--no-ping).");
			return;
		}
		context.logger.step("Validando credencial de IA...");
		const check = await ai.validateCredential();
		if (check.ok) {
			context.logger.success(
				`IA: credencial válida (modelo ${check.model ?? provider}).`,
			);
		} else if (check.kind === "invalid") {
			context.logger.error(`IA: credencial inválida — ${check.detail}`);
		} else {
			context.logger.warn(`IA: não foi possível validar — ${check.detail}`);
		}
	}

	/**
	 * Reporta o estado da credencial Jev: presença e validade (chamada mínima).
	 * Fail-open — nunca altera o exit code (`doctor` é diagnóstico).
	 */
	private async reportJevCredential(
		context: CliContext,
		noPing: boolean,
	): Promise<void> {
		const { JevClient } = await import("../../core/jev");
		const client = new JevClient();
		if (!client.isConfigured()) {
			context.logger.warn(
				`${ENV_NAMES.typeSafeApiKey} (opcional — pré-análise Jev)`,
			);
			return;
		}
		if (noPing) {
			context.logger.info("Jev: validação pulada (--no-ping).");
			return;
		}
		const check = await client.validateCredential();
		if (check.ok) {
			context.logger.success(`Jev: credencial válida (modelo ${check.model}).`);
		} else if (check.kind === "invalid") {
			context.logger.error(`Jev: credencial inválida — ${check.detail}`);
		} else {
			context.logger.warn(`Jev: não foi possível validar — ${check.detail}`);
		}
	}
}
