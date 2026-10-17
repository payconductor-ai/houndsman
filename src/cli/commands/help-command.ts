/** Comando `help` — imprime o uso e encerra. */

import { HELP } from "../help";
import type { CliContext, Command } from "./command";

export class HelpCommand implements Command {
	readonly name = "help";

	async run(_args: string[], context: CliContext): Promise<number> {
		context.out(HELP);
		return 0;
	}
}
