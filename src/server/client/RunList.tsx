/**
 * Sidebar: logo do houndsman + lista de runs (branch e nº de findings).
 */

import { describeRunStatus } from "./constants";
import type { RunSummary } from "./types";

export function RunList({
	runs,
	slug,
	onSelect,
}: {
	runs: RunSummary[];
	slug: string | null;
	onSelect: (slug: string) => void;
}) {
	return (
		<aside class="sidebar">
			<div class="brand">
				<img class="logo" src="/assets/logo.png" alt="houndsman" />
				<div>
					<h1>Houndsman</h1>
					<p class="sub">Revisões e triagem</p>
				</div>
			</div>
			<nav class="runs">
				{runs.length === 0 && <p class="empty">Nenhuma run encontrada.</p>}
				{runs.map((run) => {
					const status = describeRunStatus(run);
					return (
						<button
							type="button"
							title={`Abrir a run da branch ${run.branch}`}
							class={`run${run.slug === slug ? " active" : ""}`}
							onClick={() => onSelect(run.slug)}
						>
							<span class="run-branch">{run.branch}</span>
							<span class="run-meta">
								{run.summary.present}/{run.summary.total} presentes
							</span>
							{status && (
								<span class={`run-status status-${status.kind}`}>
									{status.label}
								</span>
							)}
						</button>
					);
				})}
			</nav>
		</aside>
	);
}
