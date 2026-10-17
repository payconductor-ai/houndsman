/**
 * Contrato dos comandos do CLI.
 *
 * `core/` continua devolvendo dados; os comandos decidem o que imprimir e o
 * exit code. O engine é carregado sob demanda (comandos sem projeto não pagam).
 */

import type { HoundsmanEngine } from "../../core/engine/houndsman-engine";
import type { LoggerLike } from "../../core/logging";

/** Contexto de execução de um comando. */
export type CliContext = {
	cwd: string;
	/** Carrega a config do projeto e devolve o engine (lazy). */
	engine: () => Promise<HoundsmanEngine>;
	/** Logger único do CLI (cores/spinner/progresso). */
	logger: LoggerLike;
	/** @deprecated use `logger.info`. */
	out: (message: string) => void;
	/** @deprecated use `logger.error`. */
	err: (message: string) => void;
};

/** Um subcomando do binário. */
export interface Command {
	readonly name: string;
	run(args: string[], context: CliContext): Promise<number>;
}
