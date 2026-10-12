/**
 * Barra de resumo da triagem (total, presentes e contagens por decisão/execução).
 */

import { DECISION_LABELS, DECISIONS } from "./constants";
import type { Summary } from "./types";

export function SummaryBar({ summary }: { summary: Summary }) {
	return (
		<div class="summary-bar">
			<span>Total: {summary.total}</span>
			<span>Presentes: {summary.present}</span>
			{DECISIONS.filter((decision) => decision !== "pending").map((decision) => (
				<span key={decision}>
					{DECISION_LABELS[decision]}: {summary.byDecision[decision] ?? 0}
				</span>
			))}
			<span>Feitos: {summary.byExecState.done ?? 0}</span>
		</div>
	);
}
