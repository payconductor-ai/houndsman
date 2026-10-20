/** Comando default — prepara ou finaliza a revisão. */

import { parseReviewArgs } from "../../core/commands/review";
import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import type { CliContext, Command } from "./command";

export class ReviewCommand implements Command {
	readonly name = "";

	async run(args: string[], context: CliContext): Promise<number> {
		const options = parseReviewArgs(args);
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
		for (const message of workspace.messages) context.out(message);

		// Sem `--pr`/`--worktree`, o engine usa o workspace gravado da review
		// (finalize após um prepare feito em worktree, por exemplo).
		const explicit = options.pr !== undefined || options.worktree !== undefined;
		const engine = await context.engine(
			explicit ? { root: workspace.root, mainRoot: workspace.mainRoot } : undefined,
		);
		const resolved = {
			...options,
			branch: workspace.branch,
			base: workspace.base,
			head: workspace.head,
			pr: workspace.prNumber,
			worktreePath: workspace.worktreePath,
		};
		const result = await engine.session(resolved).run();

		for (const message of result.messages) context.out(message);

		if ("blockers" in result && options.failOnBlocking && result.blockers > 0) {
			return 1;
		}
		return 0;
	}
}
