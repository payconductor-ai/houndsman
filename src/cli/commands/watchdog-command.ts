/** Comando `watchdog` — contexto de um watchdog. */

import { renderWatchdogContext } from "../../core/commands/watchdog";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

export class WatchdogCommand implements Command {
	readonly name = "watchdog";

	async run(args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		const parser = ArgParser.from(args);
		const id = args.find((arg) => !arg.startsWith("-"));

		if (!id) {
			context.err("Informe o id do watchdog: houndsman watchdog <id>");
			context.err(`Ids válidos: ${engine.config.watchdogIds.join(", ")}`);
			return 1;
		}

		const output = renderWatchdogContext(engine.config, id, {
			withRules: parser.has("--rules"),
			json: parser.has("--json"),
		});
		if (output === null) {
			context.err(`Watchdog '${id}' não existe.`);
			context.err(`Ids válidos: ${engine.config.watchdogIds.join(", ")}`);
			return 1;
		}

		context.out(output);
		return 0;
	}
}
