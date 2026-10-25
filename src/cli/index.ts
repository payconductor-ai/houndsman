#!/usr/bin/env bun

/**
 * Entrypoint único do `houndsman` — `houndsman [comando]`.
 *
 * Carrega a configuração do projeto (`HoundsmanConfig`) em runtime (a partir do
 * cwd) e orquestra funções/classes de `core/`. Não importa nenhum caminho do
 * projeto consumidor estaticamente.
 *
 * Cada comando carrega seus módulos por import dinâmico (lazy) — o startup não
 * paga por `server`, Jev (axios) ou `orchestrator` que o comando não usa.
 *
 * Comandos:
 *   (default)            Passo 1 — preparar (classificação + briefs + manifesto)
 *   --finalize           Passo 3 — consolidar os findings no resumo final
 *   context              Passo 0 — coletar o contexto da PR via `gh`
 *   findings <sub>       Triagem/correção dos findings (list/set/done/sync/batch/verify/submit/...)
 *   hunt [flags]         Harness local (maki): prepare → watchdogs via maki → finalize
 *   status [ping]        Mostra o status da run; `ping` renova o heartbeat da execução
 *   server               Sobe a UI local de triagem (Bun.serve)
 *   setup                Cria a configuração inicial do projeto (config + skills)
 *   update               Sincroniza os arquivos auto-gerados (.houndsman/core)
 *   doctor               Valida a configuração, o ambiente e a credencial Jev (anti-drift)
 *   test                 Roda a suíte de testes da lib
 *   watchdog <id>        Contexto de um watchdog (`--rules`, `--json`)
 *
 * Flags: `--base <b>` · `--head <ref>` · `--branch <b>` · `--config <path>` ·
 *   `--clean` · `--full` · `--no-jev` · `--no-ast` · `--fail-on-blocking`.
 */

import type { HoundsmanConfig } from "../core/config";
import { loadConfig } from "../core/config-loader";
import { HoundsmanEngine } from "../core/engine/houndsman-engine";
import { formatDuration, logger } from "../core/logging";
import { syncProjectLayerForRoot } from "../core/services/worktree-manager";
import { ArgParser } from "./arg-parser";
import type { CliContext } from "./commands/command";
import { CompareCommand } from "./commands/compare-command";
import { ContextCommand } from "./commands/context-command";
import { DoctorCommand } from "./commands/doctor-command";
import { FindingsCommand } from "./commands/findings-command";
import { HelpCommand } from "./commands/help-command";
import { HuntCommand } from "./commands/hunt-command";
import { CommandRegistry } from "./commands/registry";
import { ReviewCommand } from "./commands/review-command";
import { ServerCommand } from "./commands/server-command";
import { SetupCommand, TestCommand, UpdateCommand } from "./commands/setup-command";
import { StatusCommand } from "./commands/status-command";
import { WatchdogCommand } from "./commands/watchdog-command";
import { WorktreeCommand } from "./commands/worktree-command";
import { HELP } from "./help";

// ---------------------------------------------------------------------------
// Registry de comandos
// ---------------------------------------------------------------------------

/** Monta o registry com todos os comandos do binário. */
function buildRegistry(): CommandRegistry {
	const doctor = new DoctorCommand();
	return new CommandRegistry()
		.register(new ReviewCommand(), { fallback: true })
		.register(new HelpCommand())
		.register(new HuntCommand())
		.register(new ContextCommand())
		.register(new CompareCommand())
		.register(new FindingsCommand())
		.register(new StatusCommand())
		.register(new WatchdogCommand())
		.register(new WorktreeCommand())
		.register(new ServerCommand())
		.register(new SetupCommand())
		.register(new UpdateCommand())
		.register(new TestCommand())
		.register(doctor)
		.registerAs("check", doctor);
}

/**
 * Bootstrap do CLI: resolve o comando no registry, carrega a config sob demanda
 * e delega a execução (o comando decide log/exit).
 */
export async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const parser = ArgParser.from(argv);
	const commandName = parser.command();
	const registry = buildRegistry();
	const command = registry.resolve(commandName);

	if (!command) {
		logger.error(`Subcomando desconhecido: '${commandName}'.\n`);
		logger.info(HELP);
		process.exit(1);
	}

	let loaded: Awaited<ReturnType<typeof loadConfig>> | null = null;
	// `--json` é contrato de máquina: nada de progresso no stdout.
	const silentProgress = parser.has("--json");
	const config = async (): Promise<HoundsmanConfig> => {
		loaded ??= await (async () => {
			const started = Date.now();
			if (!silentProgress) logger.step("Carregando a configuração do projeto…");
			// Rodando dentro de um worktree, a camada gerada (`.houndsman/core`)
			// não existe (é ignorada pelo git). Repõe a partir do clone principal
			// antes de importar a config — sem isso os watchdogs não resolvem
			// `../core/types`. No clone principal é no-op.
			syncProjectLayerForRoot(process.cwd());
			const result = await loadConfig({ configPath: parser.value("--config") });
			if (!silentProgress) {
				logger.success(
					`Configuração: ${result.config.projectName} · ` +
						`${result.config.watchdogIds.length} watchdog(s) ` +
						`(${formatDuration(Date.now() - started)})`,
				);
			}
			return result;
		})();
		return loaded.config;
	};

	const context: CliContext = {
		cwd: process.cwd(),
		logger,
		out: (message) => logger.info(message),
		err: (message) => logger.error(message),
		config,
		engine: async (options = {}) => {
			return new HoundsmanEngine(await config(), {
				root: options.root,
				mainRoot: options.mainRoot,
			});
		},
	};

	const code = await command.run(parser.rest(), context);
	if (code !== 0) process.exit(code);
}

if (import.meta.main) {
	await main().catch((error) => {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
