/** Comando default — prepara ou finaliza a revisão. */

import { parseReviewArgs } from "../../core/commands/review";
import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import { displayPath } from "../../core/paths";
import { prepareProgress, stepDone } from "../progress";
import type { CliContext, Command } from "./command";

export class ReviewCommand implements Command {
	readonly name = "";

	async run(args: string[], context: CliContext): Promise<number> {
		const options = parseReviewArgs(args);
		// O carregamento da config é logado pelo bootstrap (uma vez por processo).
		const config = await context.config();
		const workspaceStarted = Date.now();
		const workspace = resolveReviewWorkspace(
			{
				cwd: context.cwd,
				base: options.base,
				head: options.head,
				branch: options.branch,
				pr: options.pr,
				worktree: options.worktree,
			},
			{
				worktreesLocation: config.worktrees?.location,
				onProgress: (message) => context.logger.step(message),
			},
		);
		for (const message of workspace.messages) context.out(message);
		stepDone(
			context.logger,
			`Workspace: ${workspace.branch} em ${displayPath(workspace.root)}`,
			workspaceStarted,
		);

		// Sem `--pr`/`--worktree`, o engine usa o workspace gravado da review
		// (finalize após um prepare feito em worktree, por exemplo).
		const explicit = options.pr !== undefined || options.worktree !== undefined;
		const engineStarted = Date.now();
		context.logger.step("Abrindo o storage da revisão…");
		const engine = await context.engine(
			explicit ? { root: workspace.root, mainRoot: workspace.mainRoot } : undefined,
		);
		stepDone(context.logger, "Storage pronto", engineStarted);
		const resolved = {
			...options,
			branch: workspace.branch,
			base: workspace.base,
			head: workspace.head,
			pr: workspace.prNumber,
			worktreePath: workspace.worktreePath,
		};
		if (options.finalize) context.logger.step("Consolidando os findings…");
		const result = await engine
			.session(resolved)
			.run(prepareProgress(context.logger));

		for (const message of result.messages) context.out(message);

		if ("blockers" in result && options.failOnBlocking && result.blockers > 0) {
			return 1;
		}
		return 0;
	}
}
