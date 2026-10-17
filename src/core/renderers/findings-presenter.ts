/**
 * Apresentação dos findings (biblioteca) — markdown/JSON do CLI.
 *
 * Separado do comando para que o mesmo texto possa ser reutilizado (CLI, UI,
 * testes) sem arrastar o parse de flags.
 */

import {
	FINDING_DECISIONS,
	FINDING_EXEC_STATES,
	type FindingDecision,
	type FindingState,
	type FindingsStateFile,
	type FindingsSummary,
} from "../findings-state";
import { SEVERITY_EMOJI, SEVERITY_ORDER, type Severity } from "../types";

/** Renderiza findings em markdown compacto (uso no agente). */
export class FindingsPresenter {
	/** Uma linha compacta por finding. */
	line(finding: FindingState): string[] {
		const emoji = SEVERITY_EMOJI[finding.severity];
		const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
		const flags = `${this.decisionLabel(finding.decision)}/${finding.execState}`;
		const count = finding.count > 1 ? ` ×${finding.count}` : "";
		const lines = [
			`- \`${finding.id}\` ${emoji} **${finding.severity}** \`${location}\` — ${finding.rule}${count}`,
			`  ${finding.message}`,
			`  _${flags}_ · watchdogs: ${finding.watchdogIds.join(", ") || "—"}`,
		];
		if (finding.comment) lines.push(`  **Comentário:** ${finding.comment}`);
		return lines;
	}

	/** Lista de findings com cabeçalho. */
	list(state: FindingsStateFile, findings: FindingState[]): string {
		if (findings.length === 0) return "Nenhum finding para o filtro informado.";
		const lines = [`# Findings — ${state.branch} (${findings.length})`, ""];
		for (const finding of findings) lines.push(...this.line(finding));
		return lines.join("\n");
	}

	/** Resumo da triagem (decisões, execução e severidade). */
	summary(state: FindingsStateFile, summary: FindingsSummary): string {
		const decisions = FINDING_DECISIONS.map(
			(decision) => `${decision} ${summary.byDecision[decision]}`,
		).join(" · ");
		const exec = FINDING_EXEC_STATES.map(
			(stateName) => `${stateName} ${summary.byExecState[stateName]}`,
		).join(" · ");
		const severities = SEVERITY_ORDER.map(
			(severity) => `${severity} ${summary.bySeverity[severity]}`,
		).join(" · ");
		return [
			`# Triagem — ${state.branch}`,
			"",
			`Total: ${summary.total} (presentes: ${summary.present})`,
			`Decisões: ${decisions}`,
			`Execução: ${exec}`,
			`Severidade: ${severities}`,
		].join("\n");
	}

	/** Mix de severidade compacto (ex.: `❌1 ⚠️2`). */
	severityBreakdown(bySeverity: Record<Severity, number>): string {
		return SEVERITY_ORDER.filter((severity) => bySeverity[severity] > 0)
			.map((severity) => `${SEVERITY_EMOJI[severity]}${bySeverity[severity]}`)
			.join(" ");
	}

	private decisionLabel(decision: FindingDecision): string {
		return decision;
	}
}
