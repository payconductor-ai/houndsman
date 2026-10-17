/**
 * Reporter de progresso de um agente.
 *
 * O journal é sempre coletado (`harness-transcript.json`); o console é opcional.
 */

import type { LoggerLike } from "../../core/logging";
import { ReviewJournal } from "../investigation/review-journal";

/** Interface de progresso. */
export interface AgentReporter {
	readonly journal: ReviewJournal;
	progress(message: string): void;
}

/** Reporter silencioso (testes). */
export class SilentReporter implements AgentReporter {
	readonly journal = new ReviewJournal();

	progress(): void {
		// intencionalmente silencioso
	}
}

/** Reporter apoiado no logger único do CLI. */
export class LoggerReporter implements AgentReporter {
	readonly journal = new ReviewJournal();

	constructor(private readonly logger: LoggerLike) {}

	progress(message: string): void {
		this.logger.progress(message);
	}
}
