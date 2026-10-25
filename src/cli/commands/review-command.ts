/** Comando default — prepara ou finaliza a revisão. */

import { ArgParser } from "../../core/arg-parser";
import { runContextCommand } from "../../core/commands/context";
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
		// PR: coleta o contexto via `gh` aqui, como o `hunt` faz. Sem isso, a skill
		// gastava um subagente só para rodar `houndsman context` antes do prepare.
		if (
			options.pr !== undefined &&
			!options.finalize &&
			!ArgParser.from(args).has("--no-context")
		) {
			const contextStarted = Date.now();
			context.logger.step("Coletando o contexto da PR via gh…");
			try {
				const collected = runContextCommand(
					engine.config,
					engine.storage,
					engine.repo,
					{
						branch: workspace.branch,
						variant: options.variant,
						worktreePath: workspace.worktreePath,
						prNumber: workspace.prNumber,
					},
				);
				stepDone(
					context.logger,
					collected.context.available
						? "Contexto da PR coletado via gh"
						: `Contexto da PR indisponível (${collected.context.reason})`,
					contextStarted,
				);
			} catch (error) {
				context.logger.warn(
					`Contexto da PR indisponível: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
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
