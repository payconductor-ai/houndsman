/**
 * Carry-over do review incremental (engine) — findings de arquivos inalterados.
 *
 * Preserva o estado anterior sem re-revisar: o prepare carrega o carry-over e o
 * finalize o mescla aos findings re-reportados.
 */

import { occurrenceKey } from "../finding-identity";
import type { FindingsStateFile } from "../findings-state";
import type { MergedFinding } from "../report-builder";
import { severityRank } from "../types";

/**
 * Chave de dedupe: `(arquivo, regra)` sem a linha — a mesma regra violada em
 * outro trecho do arquivo continua sendo o mesmo achado.
 */
function findingKey(finding: Pick<MergedFinding, "file" | "rule">): string {
	return occurrenceKey(finding);
}

/**
 * Findings do review anterior em arquivos inalterados — carregados sem
 * re-revisão (carry-over). Preserva o `foundAtSha` para o diff focado do verify.
 */
export function buildCarryover(
	previous: FindingsStateFile | null,
	changedPaths: Set<string>,
): MergedFinding[] {
	if (!previous) return [];
	return Object.values(previous.findings)
		.filter((finding) => finding.present && !changedPaths.has(finding.file))
		.map((finding) => ({
			id: finding.id,
			rule: finding.rule,
			severity: finding.severity,
			file: finding.file,
			line: finding.line ?? undefined,
			message: finding.message,
			action: finding.action,
			evidence: finding.evidence,
			scenario: finding.scenario,
			impact: finding.impact,
			confidence: finding.confidence,
			basis: finding.basis,
			foundAtSha: finding.foundAtSha,
			watchdogs: [...finding.watchdogIds],
			occurrences: finding.count,
		}));
}

/** Une os findings re-reportados com os carry-over (preserva ids anteriores). */
export function mergeCarryover(
	merged: MergedFinding[],
	carryover: readonly MergedFinding[],
): MergedFinding[] {
	const byKey = new Map(merged.map((finding) => [findingKey(finding), finding]));
	for (const carried of carryover) {
		const existing = byKey.get(findingKey(carried));
		if (existing) {
			for (const watchdog of carried.watchdogs) {
				if (!existing.watchdogs.includes(watchdog))
					existing.watchdogs.push(watchdog);
			}
			continue;
		}
		byKey.set(findingKey(carried), carried);
		merged.push(carried);
	}
	merged.sort((a, b) => {
		const bySeverity = severityRank(a.severity) - severityRank(b.severity);
		if (bySeverity !== 0) return bySeverity;
		if (a.file !== b.file) return a.file.localeCompare(b.file);
		return (a.line ?? 0) - (b.line ?? 0);
	});
	return merged;
}
