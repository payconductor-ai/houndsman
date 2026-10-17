/**
 * Verificação de findings (biblioteca) — superfície OO sobre `verify.ts`.
 *
 * O tier local (âncora de conteúdo) e o tier Jev continuam em funções puras; a
 * classe concentra a sequência usada pelo comando `findings verify`.
 */

import type {
	FileReader,
	FindingState,
	FindingsFilter,
	FindingsStateFile,
} from "../findings-state";
import {
	applyConfidence,
	applyResolutions,
	selectVerifiable,
	summarizeVerify,
	type VerifyBasis,
	type VerifyEntry,
	type VerifySummary,
	verifyLocal,
} from "../verify";

/** Encadeia seleção, tier local, confirmação Jev e persistência. */
export class Verifier {
	/** Fila de verificação (presentes, sem `ignore`). */
	select(state: FindingsStateFile, filter: FindingsFilter = {}): FindingState[] {
		return selectVerifiable(state, filter);
	}

	/** Tier 0 — checagem local por reancoragem de conteúdo. */
	verifyLocal(findings: readonly FindingState[], readFile: FileReader): VerifyEntry[] {
		return verifyLocal(findings, readFile);
	}

	/** Tier 1 — aplica confirmações externas (Jev ou IA) aos casos ambíguos. */
	applyConfidence(
		entries: VerifyEntry[],
		confidence: Map<string, number>,
		threshold: number,
		basis: VerifyBasis = "jev",
	): number {
		return applyConfidence(entries, confidence, threshold, basis);
	}

	/** Compatibilidade: confirmação via Jev. */
	applyJev(
		entries: VerifyEntry[],
		confidence: Map<string, number>,
		threshold: number,
	): number {
		return applyConfidence(entries, confidence, threshold, "jev");
	}

	/** Contagem por status. */
	summarize(entries: readonly VerifyEntry[]): VerifySummary {
		return summarizeVerify(entries);
	}

	/** Persiste os `resolved` como `done`. */
	applyResolutions(
		state: FindingsStateFile,
		entries: readonly VerifyEntry[],
		now?: string,
	): string[] {
		return applyResolutions(state, entries, now);
	}
}
