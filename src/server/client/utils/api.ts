/**
 * Helpers de acesso à API local do servidor.
 */

import { DECISIONS, EXEC_STATES, SEVERITY_ORDER } from "./constants";
import type { Decision, ExecState, Finding, Severity, Summary } from "./types";

/** `fetch` JSON: lança com o corpo do erro quando a resposta não é 2xx. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** Recalcula o resumo a partir dos findings atuais (contadores vivos na UI). */
export function computeSummary(findings: Finding[]): Summary {
	const byDecision = Object.fromEntries(DECISIONS.map((d) => [d, 0])) as Record<
		Decision,
		number
	>;
	const byExecState = Object.fromEntries(EXEC_STATES.map((e) => [e, 0])) as Record<
		ExecState,
		number
	>;
	const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<
		Severity,
		number
	>;
	let present = 0;
	for (const finding of findings) {
		if (finding.present) present++;
		byDecision[finding.decision]++;
		byExecState[finding.execState]++;
		bySeverity[finding.severity]++;
	}
	return { total: findings.length, present, byDecision, byExecState, bySeverity };
}
