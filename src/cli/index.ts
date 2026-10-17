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
 *   --finalize           Passo 3 — consolidar os findings em review.md
 *   context              Passo 0 — coletar o contexto da PR via `gh`
 *   findings <sub>       Triagem/correção dos findings (list/set/done/sync/batch/verify/submit/...)
 *   server               Sobe a UI local de triagem (Bun.serve)
 *   setup                Cria a configuração inicial do projeto (config + skills)
 *   update               Sincroniza os arquivos auto-gerados (.houndsman/core)
 *   doctor               Valida a configuração, o ambiente e a credencial Jev (anti-drift)
 *   test                 Roda a suíte de testes da lib
 *   watchdog <id>        Contexto de um watchdog (`--rules`, `--json`)
 *
 * Flags: `--base <b>` · `--head <ref>` · `--branch <b>` · `--config <path>` ·
 *   `--clean` · `--full` · `--no-jev` · `--fail-on-blocking`.
 */

import { loadConfig } from "../core/config-loader";
import { HoundsmanEngine } from "../core/engine/houndsman-engine";
import { ArgParser } from "./arg-parser";
import type { CliContext } from "./commands/command";
import { ContextCommand } from "./commands/context-command";
import { DoctorCommand } from "./commands/doctor-command";
import { FindingsCommand } from "./commands/findings-command";
import { HelpCommand } from "./commands/help-command";
import { CommandRegistry } from "./commands/registry";
import { ReviewCommand } from "./commands/review-command";
import { ServerCommand } from "./commands/server-command";
import { SetupCommand, TestCommand, UpdateCommand } from "./commands/setup-command";
import { WatchdogCommand } from "./commands/watchdog-command";
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
		.register(new ContextCommand())
		.register(new FindingsCommand())
		.register(new WatchdogCommand())
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
		console.error(`Subcomando desconhecido: '${commandName}'.\n`);
		console.error(HELP);
		process.exit(1);
	}

	const context: CliContext = {
		cwd: process.cwd(),
		out: (message) => console.log(message),
		err: (message) => console.error(message),
		engine: async () => {
			const { config } = await loadConfig({
				configPath: parser.value("--config"),
			});
			return new HoundsmanEngine(config);
		},
	};

	const code = await command.run(parser.rest(), context);
	if (code !== 0) process.exit(code);
}

if (import.meta.main) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
