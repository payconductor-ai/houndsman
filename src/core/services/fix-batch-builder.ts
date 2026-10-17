/**
 * Montagem do lote de correção (biblioteca) — superfície OO sobre `fix-batch`.
 */

import type { FindingsStateFile } from "../findings-state";
import { buildFixBatch, type FixBatchOptions, type FixBatchResult } from "../fix-batch";

/** Constrói o lote de correção a partir do estado de triagem. */
export class FixBatchBuilder {
	build(state: FindingsStateFile, options: FixBatchOptions = {}): FixBatchResult {
		return buildFixBatch(state, options);
	}
}
