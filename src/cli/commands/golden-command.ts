/**
 * Comando `golden` — avalia as runs da branch contra defeitos congelados.
 *
 * Exemplo:
 *   houndsman golden .houndsman/golden/asaas-split.json
 *   houndsman golden .houndsman/golden/asaas-split.json --variant otimizado-4
 */

import { runGolden } from "../../core/commands/golden";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

/** Flags com valor (não entram nos positionais). */
const VALUE_FLAGS = new Set(["--branch", "--variant", "--slug", "--config"]);

export const GOLDEN_HELP = `Uso: houndsman golden <arquivo.json> [flags]

Avalia uma run (ou todas as variantes da branch) contra um golden set —
defeitos já confirmados no código — e reporta recall/precisão.

Flags:
  --branch <nome>    Branch alvo (default: a atual do git)
  --variant <rótulo> Avalia só uma variante
  --slug <slug>      Avalia uma run específica
  --json             Saída JSON (sem markdown)

O relatório é gravado como \`golden-<slug>.md|json\` na run avaliada.

Formato do arquivo:
  { "version": 1, "title": "...", "commit": "abc1234",
    "expected": [{ "id": "seller-api-key", "file": "src/a.ts",
                   "line": 116, "tolerance": 30, "match": "sellerApiKey",
                   "severity": "blocking", "note": "..." }] 1}

Exemplos:
  houndsman golden .houndsman/golden/asaas-split.json
  houndsman golden .houndsman/golden/asaas-split.json --variant otimizado-5`;

/** Primeiro argumento posicional (ignora flags com valor). */
function positionalFile(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--")) {
			if (VALUE_FLAGS.has(arg)) index++;
			continue;
		}
		return arg;
	}
	return undefined;
}

export class GoldenCommand implements Command {
	readonly name = "golden";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		if (parser.has("--help") || parser.has("-h")) {
			context.logger.info(GOLDEN_HELP);
			return 0;
		}

		const file = positionalFile(args);
		if (!file) {
			context.logger.info(GOLDEN_HELP);
			return 1;
		}

		const engine = await context.engine();
		try {
			const result = runGolden(engine.storage, engine.repo, {
				file,
				branch: parser.value("--branch"),
				variant: parser.value("--variant"),
				slug: parser.value("--slug"),
			});
			if (parser.has("--json")) {
				context.logger.info(result.json.trimEnd());
			} else {
				context.logger.info(result.markdown.trimEnd());
				context.logger.success(
					`Golden salvo em ${result.artifacts?.markdown} (run ${result.target.slug}).`,
				);
			}
			return 0;
		} catch (error) {
			context.logger.error(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			engine.close();
		}
	}
}
