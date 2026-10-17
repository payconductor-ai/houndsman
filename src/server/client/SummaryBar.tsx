/**
 * Métricas da triagem: cards de KPI (Total/Executar/Ignorar/Feitos) e a barra de
 * progresso da correção (feitos ÷ total).
 */

import type { Summary } from "./types";

function Kpi({
	label,
	value,
	tone,
	hint,
}: {
	label: string;
	value: number;
	tone: "total" | "execute" | "ignore" | "done";
	hint?: string;
}) {
	return (
		<div class={`kpi kpi-${tone}`} title={hint}>
			<span class="kpi-label">{label}</span>
			<span class="kpi-value">{value}</span>
			{hint && <span class="kpi-hint">{hint}</span>}
		</div>
	);
}

export function SummaryBar({ summary }: { summary: Summary }) {
	const done = summary.byExecState.done ?? 0;
	const total = summary.total - (summary.byDecision.ignore || 0);
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;

	return (
		<>
			<div class="kpis">
				<Kpi
					label="Total"
					value={summary.total}
					tone="total"
					hint={`${summary.present} presentes`}
				/>
				<Kpi
					label="Executar"
					value={summary.byDecision.execute ?? 0}
					tone="execute"
					hint="marcados para auto-fix"
				/>
				<Kpi
					label="Ignorar"
					value={summary.byDecision.ignore ?? 0}
					tone="ignore"
					hint="descartados na triagem"
				/>
				<Kpi label="Feitos" value={done} tone="done" hint="corrigidos" />
			</div>
			<div class="progress">
				<div class="progress-head">
					<span>Progresso da correção</span>
					<span class="pct">{pct}%</span>
				</div>
				<div
					class="progress-track"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct}
					title={`${done} de ${summary.total} findings feitos`}
				>
					<span class="progress-fill" style={{ width: `${pct}%` }} />
				</div>
			</div>
		</>
	);
}
