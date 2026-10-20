/**
 * Comando `worktree` — gerencia os worktrees de revisão.
 *
 * `list` (default) · `add --pr <n>` · `add --branch <b> [--ref <r>]` ·
 * `remove <branch|path> [--force]` · `prune` · `path <branch>`.
 */

import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import { WorktreeManager } from "../../core/services/worktree-manager";
import { resolveWorktreesRoot } from "../../core/storage/paths";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

/** Executa a manutenção dos worktrees. */
export class WorktreeCommand implements Command {
	readonly name = "worktree";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		const action = parser.command() ?? "list";
		const config = await context.config();
		const engine = await context.engine();
		const manager = new WorktreeManager(engine.git, {
			repoKey: engine.repo.key,
			repoRoot: engine.mainRoot,
			baseDir: resolveWorktreesRoot(config.worktrees?.location, engine.mainRoot),
		});

		switch (action) {
			case "list": {
				const entries = manager.managed();
				if (entries.length === 0) {
					context.out(`Nenhum worktree em ${manager.baseDir}.`);
					return 0;
				}
				context.out(`Worktrees em ${manager.baseDir}:`);
				for (const entry of entries) {
					const branch = entry.branch
						? entry.branch.replace(/^refs\/heads\//, "")
						: "(detached)";
					context.out(
						`- ${branch} · ${entry.path}${entry.prunable ? " · órfão" : ""}`,
					);
				}
				return 0;
			}
			case "add": {
				const pr = parser.value("--pr");
				if (pr) {
					const number = Number.parseInt(pr, 10);
					if (!Number.isFinite(number) || number <= 0) {
						context.err(`--pr inválido: '${pr}'.`);
						return 1;
					}
					const workspace = resolveReviewWorkspace(
						{
							cwd: context.cwd,
							base: "main",
							head: "HEAD",
							pr: number,
						},
						{ worktreesLocation: config.worktrees?.location },
					);
					for (const message of workspace.messages) context.out(message);
					context.out(workspace.worktreePath ?? workspace.root);
					return 0;
				}

				const branch = parser.value("--branch");
				if (!branch) {
					context.err("Informe --pr <n> ou --branch <nome>.");
					return 1;
				}
				const ref = parser.value("--ref") ?? branch;
				const result = manager.ensure({ branch, ref });
				context.out(
					`${result.created ? "Criado" : "Reutilizado"}: ${result.path} @ ${result.head.slice(0, 7)}`,
				);
				return 0;
			}
			case "remove": {
				const target = parser.positionals()[1] ?? parser.value("--branch");
				if (!target) {
					context.err("Informe a branch ou o caminho do worktree.");
					return 1;
				}
				const result = manager.remove(target, { force: parser.has("--force") });
				if (!result.removed) {
					context.err(
						`Worktree não removido: ${result.detail ?? "desconhecido"}.`,
					);
					return 1;
				}
				context.out(`Worktree removido: ${target}.`);
				return 0;
			}
			case "prune": {
				manager.prune();
				context.out(`Worktrees órfãos removidos em ${manager.baseDir}.`);
				return 0;
			}
			case "path": {
				const branch = parser.positionals()[1] ?? parser.value("--branch");
				if (!branch) {
					context.err("Informe a branch.");
					return 1;
				}
				context.out(manager.pathFor(branch));
				return 0;
			}
			default:
				context.err(
					`Ação desconhecida em 'worktree': '${action}'. Use list, add, remove, prune ou path.`,
				);
				return 1;
		}
	}
}
