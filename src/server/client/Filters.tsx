/**
 * Barra de filtros dos findings: busca, decisão, severidade e "mostrar ausentes".
 */

import { DECISION_LABELS, DECISIONS, SEVERITY_ORDER } from "./constants";
import type { Decision, Severity } from "./types";

export type FiltersState = {
	query: string;
	decision: "all" | Decision;
	severity: "all" | Severity;
	showAbsent: boolean;
};

export function Filters({
	value,
	onChange,
}: {
	value: FiltersState;
	onChange: (next: FiltersState) => void;
}) {
	const patch = (part: Partial<FiltersState>) => onChange({ ...value, ...part });

	return (
		<div class="filters">
			<input
				title="Filtrar por arquivo, regra ou mensagem"
				placeholder="Buscar arquivo, regra ou mensagem…"
				value={value.query}
				onInput={(event) =>
					patch({ query: (event.target as HTMLInputElement).value })
				}
			/>
			<select
				title="Filtrar por decisão de triagem"
				value={value.decision}
				onChange={(event) =>
					patch({
						decision: (event.target as HTMLSelectElement).value as
							| "all"
							| Decision,
					})
				}
			>
				<option value="all">Todas as decisões</option>
				{DECISIONS.map((decision) => (
					<option value={decision}>{DECISION_LABELS[decision]}</option>
				))}
			</select>
			<select
				title="Filtrar por severidade"
				value={value.severity}
				onChange={(event) =>
					patch({
						severity: (event.target as HTMLSelectElement).value as
							| "all"
							| Severity,
					})
				}
			>
				<option value="all">Todas as severidades</option>
				{SEVERITY_ORDER.map((severity) => (
					<option value={severity}>{severity}</option>
				))}
			</select>
			<label
				class="toggle"
				title="Incluir findings que sumiram do último relatório"
			>
				<input
					type="checkbox"
					checked={value.showAbsent}
					onChange={(event) =>
						patch({
							showAbsent: (event.target as HTMLInputElement).checked,
						})
					}
				/>
				mostrar ausentes
			</label>
		</div>
	);
}
