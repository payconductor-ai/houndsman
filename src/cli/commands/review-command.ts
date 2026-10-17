/** Comando default — prepara ou finaliza a revisão. */

import { parseReviewArgs } from "../../core/commands/review";
import { resolveArtifactDir } from "../../core/config";
import type { CliContext, Command } from "./command";

export class ReviewCommand implements Command {
	readonly name = "";

	async run(args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		const options = parseReviewArgs(args, resolveArtifactDir(engine.config));
		const result = await engine.session(options).run();

		for (const message of result.messages) context.out(message);

		if ("blockers" in result && options.failOnBlocking && result.blockers > 0) {
			return 1;
		}
		return 0;
	}
}
