/**
 * Instância pronta do logger (`import { logger } from "../core/logging"`).
 *
 * Infraestrutura compartilhada por `cli` e `server`. Módulos de
 * negócio do core não escrevem saída.
 */

import { Logger } from "./logger";

export const logger = new Logger();

export type {
	LoggerLike,
	LoggerOptions,
	SpinnerLike,
} from "./logger";
export { Logger, SilentLogger } from "./logger";
export type { ProgressBoardOptions } from "./progress";
export {
	formatDuration,
	ParallelPhaseReporter,
	PhaseReporter,
	ProgressBoard,
} from "./progress";
