/**
 * Serviço de classificação (biblioteca) — superfície OO sobre as funções puras.
 *
 * Mantém as funções exportadas (`classifyEntries`/`classifyRange`) para a API
 * pública e os testes; a classe devolve `Classification` (domínio).
 */

import type { AstFacts } from "../ast/types";
import type { HoundsmanConfig } from "../config";
import type { DiffSource } from "../diff-source";
import { Classification } from "../domain/classification";
import { classifyEntries, classifyRange, type parseEntries } from "../file-classifier";
import type { ChurnMap } from "../types";

/** Classificador de arquivos alterados por domínio de review. */
export class FileClassifier {
	private readonly config: HoundsmanConfig;

	constructor(config: HoundsmanConfig) {
		this.config = config;
	}

	/** Classifica entradas já parseadas (`git diff --name-status`). */
	classify(
		entries: ReturnType<typeof parseEntries>,
		churn: ChurnMap = {},
		astFacts?: ReadonlyMap<string, AstFacts>,
	): Classification {
		return new Classification(classifyEntries(entries, this.config, churn, astFacts));
	}

	/** Executa o diff e classifica os arquivos entre `base` e `head`. */
	classifyRange(
		base: string,
		head: string,
		diff?: DiffSource,
		astFacts?: ReadonlyMap<string, AstFacts>,
	): Classification {
		return new Classification(classifyRange(base, head, this.config, diff, astFacts));
	}
}
