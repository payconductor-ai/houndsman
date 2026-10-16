/**
 * Barra de filtros dos findings: busca, chips de severidade, chips de decisão e
 * o toggle "ausentes".
 */

import { DECISION_LABELS, DECISIONS, SEVERITY_LABELS, SEVERITY_ORDER } from "./constants";
import { Search, Watch } from "./icons";
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
			<label class="search" title="Filtrar por arquivo, regra ou mensagem">
				<Search size={15} />
				<input
					type="text"
					placeholder="Buscar arquivo, regra ou mensagem…"
					value={value.query}
					onInput={(event) =>
						patch({ query: (event.target as HTMLInputElement).value })
					}
				/>
				{value.query && (
					<button
						type="button"
						class="search-clear"
						title="Limpar busca"
						onClick={() => patch({ query: "" })}
					>
						×
					</button>
				)}
			</label>

			<div class="chips">
				<button
					type="button"
					title="Todas as severidades"
					class={`chip${value.severity === "all" ? " active" : ""}`}
					onClick={() => patch({ severity: "all" })}
				>
					Todas
				</button>
				{SEVERITY_ORDER.map((severity) => (
					<button
						type="button"
						title={`Somente severidade ${severity}`}
						class={`chip sev-${severity}${value.severity === severity ? " active" : ""}`}
						onClick={() => patch({ severity })}
					>
						{SEVERITY_LABELS[severity]}
					</button>
				))}
			</div>

			<div class="chips">
				<button
					type="button"
					title="Todas as decisões"
					class={`chip${value.decision === "all" ? " active" : ""}`}
					onClick={() => patch({ decision: "all" })}
				>
					Todas
				</button>
				{DECISIONS.map((decision) => (
					<button
						type="button"
						title={`Somente ${DECISION_LABELS[decision]}`}
						class={`chip dec-${decision}${value.decision === decision ? " active" : ""}`}
						onClick={() => patch({ decision })}
					>
						{DECISION_LABELS[decision]}
					</button>
				))}
			</div>

			<button
				type="button"
				title="Incluir findings que sumiram do último relatório"
				class={`chip${value.showAbsent ? " active" : ""}`}
				onClick={() => patch({ showAbsent: !value.showAbsent })}
			>
				<Watch size={13} /> Ausentes
			</button>
		</div>
	);
}
