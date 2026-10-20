/**
 * Seção `Execuções` da sidebar: lista das runs revisadas, com status, data e
 * contagem de findings. Selecionar uma run troca apenas o conteúdo principal.
 */

import { BranchIcon, Clock, Sparkles } from "./icons";
import type { SidebarSectionContext } from "./sidebar-sections";
import { describeRunStatus } from "./utils/constants";
import { formatRunTime } from "./utils/format";
import type { RunSummary } from "./utils/types";

function RunItem({
	run,
	active,
	onSelect,
}: {
	run: RunSummary;
	active: boolean;
	onSelect: (slug: string) => void;
}) {
	const status = describeRunStatus(run);
	const fixReady = status?.kind === "fix_done";
	return (
		<button
			type="button"
			title={`Abrir a run da branch ${run.branch}`}
			class={`run${active ? " active" : ""}`}
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
					<span class={`run-status status-${status.kind}`}>{status.label}</span>
				)
			)}
		</button>
	);
}

export function RunsSection({ runs, slug, onSelect }: SidebarSectionContext) {
	return (
		<nav class="runs" aria-label="Execuções">
			{runs.length === 0 && <p class="empty">Nenhuma run encontrada.</p>}
			{runs.map((run) => (
				<RunItem
					key={run.slug}
					run={run}
					active={run.slug === slug}
					onSelect={onSelect}
				/>
			))}
		</nav>
	);
}
