/**
 * Comando `compare` — teste A/B entre duas runs (por slug ou branch+variantes).
 *
 * Exemplo:
 *   houndsman compare --branch feature/x --a baseline --b otimizado
 *   houndsman compare feature-x--baseline-1a2b3c feature-x--otimizado-9f8e7d
 */

import { listRunsForCompare, runCompare } from "../../core/commands/compare";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

/** Flags com valor (não entram nos positionais). */
const VALUE_FLAGS = new Set(["--branch", "--a", "--b", "--config"]);

export const COMPARE_HELP = `Uso: houndsman compare [<slugA> <slugB>] [flags]

Compara duas runs da mesma branch e grava o relatório na run B.

Flags:
  --branch <nome>   Branch alvo (default: a atual do git)
  --a <variante>    Rótulo A (default: run principal)
  --b <variante>    Rótulo B (obrigatório sem slugs)
  --list            Lista as runs/variantes com contagem por severidade
  --json            Saída JSON (sem markdown)

Exemplos:
  houndsman compare --branch feature/x --a baseline --b otimizado
  houndsman compare feature-x--baseline-1a2b3c feature-x--otimizado-9f8e7d
  houndsman compare --list --branch feature/x`;

/** Argumentos posicionais (ignora flags com valor). */
function positionals(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--")) {
			if (VALUE_FLAGS.has(arg)) index++;
			continue;
		}
		result.push(arg);
	}
	return result;
}

export class CompareCommand implements Command {
	readonly name = "compare";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		if (parser.has("--help") || parser.has("-h")) {
			context.out(COMPARE_HELP);
			return 0;
		}

		const engine = await context.engine();
		const branch = parser.value("--branch");

		if (parser.has("--list")) {
			const runs = listRunsForCompare(engine.storage, engine.repo, branch);
			if (runs.length === 0) {
				context.out("Nenhuma run encontrada.");
				engine.close();
				return 0;
			}
			context.logger.table([
				["slug", "variante", "findings", "blocking", "attention", "atualizada"],
				...runs.map((run) => [
					run.slug,
					run.variant ?? "(principal)",
					String(run.findings),
					String(run.bySeverity.blocking),
					String(run.bySeverity.attention),
					run.updatedAt,
				]),
			]);
			engine.close();
			return 0;
		}

		const [slugA, slugB] = positionals(args);
		if (slugA && !slugB) {
			context.err(
				"Passe dois slugs (`houndsman compare <a> <b>`) ou use --b <variante>.",
			);
			return 1;
		}
		try {
			const result = runCompare(engine.storage, engine.repo, {
				slugA,
				slugB,
				branch,
				variantA: parser.value("--a"),
				variantB: parser.value("--b"),
			});
			if (parser.has("--json")) {
				context.out(result.json.trimEnd());
			} else {
				context.out(result.markdown.trimEnd());
				context.logger.success(
					`Comparação salva em ${result.artifacts.markdown} (run ${result.b.slug}).`,
				);
			}
			return 0;
		} catch (error) {
			context.err(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			engine.close();
		}
	}
}
