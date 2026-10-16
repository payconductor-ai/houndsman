/**
 * Sidebar: logo do houndsman + lista de execuções (mais recentes primeiro),
 * com data/hora, relação de findings presentes e badge de correção pronta.
 */

import { describeRunStatus } from "./constants";
import { formatRunTime } from "./format";
import { BranchIcon, Clock, Sparkles } from "./icons";
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
				<img class="logo" src="/assets/logo.png" alt="" />
				<div>
					<h1>Houndsman</h1>
					<p class="sub">Revisões e triagem</p>
				</div>
			</div>
			<p class="section-label">Execuções</p>
			<nav class="runs">
				{runs.length === 0 && <p class="empty">Nenhuma run encontrada.</p>}
				{runs.map((run) => {
					const status = describeRunStatus(run);
					const fixReady = status?.kind === "fix_done";
					return (
						<button
							type="button"
							title={`Abrir a run da branch ${run.branch}`}
							class={`run${run.slug === slug ? " active" : ""}`}
							onClick={() => onSelect(run.slug)}
						>
							<span class="run-top">
								<BranchIcon size={14} class="run-icon" />
								<span class="run-branch">{run.branch}</span>
							</span>
							<span class="run-meta">
								<span class="run-when">
									<Clock size={12} />
									{formatRunTime(run.updatedAt) || "sem data"}
								</span>
								<span
									class="run-count"
									title={`${run.summary.present} de ${run.summary.total} findings presentes`}
								>
									{run.summary.present}/{run.summary.total}
								</span>
							</span>
							{fixReady ? (
								<span class="run-badge">
									<Sparkles size={12} /> Correção pronta
								</span>
							) : (
								status && (
									<span class={`run-status status-${status.kind}`}>
										{status.label}
									</span>
								)
							)}
						</button>
					);
				})}
			</nav>
		</aside>
	);
}
