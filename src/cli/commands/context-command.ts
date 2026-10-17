/** Comando `context` — coleta o contexto da PR via `gh` (Passo 0). */

import { runContextCommand } from "../../core/commands/context";
import { relFromRoot } from "../../core/paths";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

export class ContextCommand implements Command {
	readonly name = "context";

	async run(args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		const parser = ArgParser.from(args);
		const { paths, context: pr } = runContextCommand(engine.config, {
			branch: parser.value("--branch"),
			dir: parser.value("--dir"),
		});

		if (pr.available) {
			const src = pr.source;
			const label = [src?.number ? `#${src.number}` : "", src?.title ?? ""]
				.filter(Boolean)
				.join(" ");
			context.out(
				`[houndsman] PR ${label} (${src?.head} → ${src?.base}), ${pr.stats?.files ?? 0} arquivo(s).`,
			);
			context.out(`[houndsman] contexto: ${relFromRoot(paths.context)}`);
			context.out(`[houndsman] brief: ${relFromRoot(paths.brief)}`);
			context.out(
				`[houndsman] próximo passo: subagente resume em ${relFromRoot(paths.summary)}`,
			);
		} else {
			context.out(`[houndsman] contexto indisponível (${pr.reason}): ${pr.detail}`);
			context.out(`[houndsman] marcador: ${relFromRoot(paths.context)}`);
		}
		return 0;
	}
}
