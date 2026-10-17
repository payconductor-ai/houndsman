/** Comando `findings` — triagem/correção (inclui verify/submit). */

import {
	runFindingsCommand,
	runSubmitCommand,
	runVerifyCommand,
} from "../../core/commands/findings";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

export class FindingsCommand implements Command {
	readonly name = "findings";

	async run(args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		const sub = ArgParser.from(args).command();
		const result =
			sub === "verify"
				? await runVerifyCommand(engine.config, engine.storage, engine.repo, args)
				: sub === "submit"
					? await runSubmitCommand(
							engine.config,
							engine.storage,
							engine.repo,
							args,
						)
					: runFindingsCommand(
							engine.config,
							engine.storage,
							engine.repo,
							args,
						);

		if (result.exitCode !== 0) context.err(result.output);
		else context.out(result.output);
		return result.exitCode;
	}
}
