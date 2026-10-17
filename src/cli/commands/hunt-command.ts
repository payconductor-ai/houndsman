/** Comando `hunt` — revisão nativa com IA (harness próprio). */

import { HuntHarness } from "../../harness";
import { parseHuntArgs } from "../../harness/hunt/hunt-options";
import type { CliContext, Command } from "./command";

/** Executa o harness nativo. */
export class HuntCommand implements Command {
	readonly name = "hunt";

	async run(args: string[], context: CliContext): Promise<number> {
		const options = parseHuntArgs(args);
		const engine = await context.engine();
		try {
			const harness = await HuntHarness.from(engine, options, context.logger);
			const result = await harness.run();
			for (const message of result.messages) context.logger.info(message);
			if (result.status === "failed") return 1;
			if (options.failOnBlocking && result.blockers > 0) return 1;
			return 0;
		} finally {
			engine.close();
		}
	}
}
