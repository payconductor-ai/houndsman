/** Comando `context` — coleta o contexto da PR via `gh` (Passo 0). */

import { runContextCommand } from "../../core/commands/context";
import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import { displayPath } from "../../core/paths";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

export class ContextCommand implements Command {
	readonly name = "context";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		const prFlag = parser.value("--pr");
		const worktreeFlag = parser.value("--worktree");
		const prNumber = prFlag ? Number.parseInt(prFlag, 10) : undefined;
		if (prFlag && (!Number.isFinite(prNumber) || (prNumber ?? 0) <= 0)) {
			context.err(`--pr inválido: '${prFlag}'.`);
			return 1;
		}
		if (prNumber !== undefined && worktreeFlag !== undefined) {
			context.err("Use --pr ou --worktree, não os dois.");
			return 1;
		}

		const config = await context.config();
		const workspace =
			prNumber !== undefined || worktreeFlag !== undefined
				? resolveReviewWorkspace(
						{
							cwd: context.cwd,
							base: "main",
							head: "HEAD",
							branch: parser.value("--branch"),
							pr: prNumber,
							worktree: worktreeFlag,
						},
						{ worktreesLocation: config.worktrees?.location },
					)
				: undefined;
		for (const message of workspace?.messages ?? []) context.out(message);

		const engine = await context.engine(
			workspace
				? { root: workspace.root, mainRoot: workspace.mainRoot }
				: undefined,
		);
		const { paths, context: pr } = runContextCommand(
			engine.config,
			engine.storage,
			engine.repo,
			{
				branch: workspace?.branch ?? parser.value("--branch"),
				worktreePath: workspace?.worktreePath,
				prNumber: workspace?.prNumber,
			},
		);

		if (pr.available) {
			const src = pr.source;
			const label = [src?.number ? `#${src.number}` : "", src?.title ?? ""]
				.filter(Boolean)
				.join(" ");
			context.out(
				`[houndsman] PR ${label} (${src?.head} → ${src?.base}), ${pr.stats?.files ?? 0} arquivo(s).`,
			);
			context.out(`[houndsman] contexto: ${displayPath(paths.context)}`);
			context.out(`[houndsman] brief: ${displayPath(paths.brief)}`);
			context.out(
				`[houndsman] próximo passo: subagente resume em ${displayPath(paths.summary)}`,
			);
		} else {
			context.out(`[houndsman] contexto indisponível (${pr.reason}): ${pr.detail}`);
			context.out(`[houndsman] marcador: ${displayPath(paths.context)}`);
		}
		return 0;
	}
}
