/**
 * Carry-over do review incremental (engine) — findings de arquivos inalterados.
 *
 * Preserva o estado anterior sem re-revisar: o prepare carrega o carry-over e o
 * finalize o mescla aos findings re-reportados.
 */

import type { FindingsStateFile } from "../findings-state";
import type { MergedFinding } from "../report-builder";
import { severityRank } from "../types";

/** Chave de dedupe de finding: `(file, line, rule)`. */
function findingKey(finding: Pick<MergedFinding, "file" | "line" | "rule">): string {
	return `${finding.file}|${finding.line ?? ""}|${finding.rule}`;
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
			foundAtSha: finding.foundAtSha,
			watchdogs: [...finding.watchdogIds],
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
