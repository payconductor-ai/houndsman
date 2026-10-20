/** Comando `hunt` — revisão nativa com IA (harness próprio). */

import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import { HuntHarness } from "../../harness";
import { parseHuntArgs } from "../../harness/hunt/hunt-options";
import type { CliContext, Command } from "./command";

/** Executa o harness nativo. */
export class HuntCommand implements Command {
	readonly name = "hunt";

	async run(args: string[], context: CliContext): Promise<number> {
		const options = parseHuntArgs(args);
		const config = await context.config();
		const workspace = resolveReviewWorkspace(
			{
				cwd: context.cwd,
				base: options.base,
				head: options.head,
				branch: options.branch,
				pr: options.pr,
				worktree: options.worktree,
			},
			{ worktreesLocation: config.worktrees?.location },
		);
		for (const message of workspace.messages) context.logger.info(message);

		const engine = await context.engine({
			root: workspace.root,
			mainRoot: workspace.mainRoot,
		});
		const resolved = {
			...options,
			branch: workspace.branch,
			base: workspace.base,
			head: workspace.head,
			pr: workspace.prNumber,
			worktreePath: workspace.worktreePath,
		};
		try {
			const harness = await HuntHarness.from(engine, resolved, context.logger);
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
