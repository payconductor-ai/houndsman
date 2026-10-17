/**
 * Renderização do relatório (biblioteca) — superfície OO sobre `report-builder`.
 *
 * O texto continua nas funções puras; a classe fixa o resolver de nomes e evita
 * repetir a lista de argumentos no orquestrador.
 */

import type { JevCandidate } from "../jev";
import {
	type ContextSummary,
	type DomainReport,
	type MergedFinding,
	renderDomainReport,
	renderReport,
	type WatchdogNameResolver,
	type WatchdogReport,
} from "../report-builder";

/** Renderiza o relatório consolidado e os relatórios por domínio. */
export class ReportRenderer {
	private readonly nameOf: WatchdogNameResolver;

	constructor(nameOf: WatchdogNameResolver) {
		this.nameOf = nameOf;
	}

	/** Relatório consolidado (`review.md`). */
	render(
		branch: string,
		reports: WatchdogReport[],
		merged: MergedFinding[],
		coverage: { classified?: Record<string, string[]> },
		context?: ContextSummary | null,
		candidates?: JevCandidate[],
		domains: readonly DomainReport[] = [],
	): string {
		return renderReport(
			branch,
			reports,
			merged,
			coverage,
			context,
			candidates,
			this.nameOf,
			domains,
		);
	}

	/** Relatório isolado de um watchdog (`review.<id>.md`). */
	renderDomain(
		branch: string,
		report: WatchdogReport,
		merged: MergedFinding[],
		expectedFiles: number,
		context?: ContextSummary | null,
	): string {
		return renderDomainReport(
			branch,
			report,
			merged,
			expectedFiles,
			context,
			this.nameOf,
		);
	}
}
