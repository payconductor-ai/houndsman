/**
 * App: layout do servidor — sidebar de runs, abas (Findings/Artefatos), legenda
 * da aba ativa e os painéis. Concentra o estado e as chamadas à API.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { api, computeSummary } from "./api";
import { TAB_CAPTIONS } from "./constants";
import { Filters, type FiltersState } from "./Filters";
import { FindingsList } from "./FindingsList";
import { RunList } from "./RunList";
import { SummaryBar } from "./SummaryBar";
import type { Finding, FindingsResponse, RunSummary } from "./types";

type Tab = "findings" | "artifacts";

export function App() {
	const [runs, setRuns] = useState<RunSummary[]>([]);
	const [slug, setSlug] = useState<string | null>(null);
	const [data, setData] = useState<FindingsResponse | null>(null);
	const [tab, setTab] = useState<Tab>("findings");
	const [filters, setFilters] = useState<FiltersState>({
		query: "",
		decision: "all",
		severity: "all",
		showAbsent: false,
	});
	const [error, setError] = useState("");

	const reloadRuns = useCallback(async () => {
		try {
			const { runs: list } = await api<{ runs: RunSummary[] }>("/api/runs");
			setRuns(list);
			setSlug((current) => current ?? list[0]?.slug ?? null);
		} catch (err) {
			setError(String(err));
		}
	}, []);

	const loadFindings = useCallback(async (target: string) => {
		try {
			setData(await api<FindingsResponse>(`/api/runs/${target}/findings?all=1`));
			setError("");
		} catch (err) {
			setError(String(err));
		}
	}, []);

	useEffect(() => {
		reloadRuns();
	}, [reloadRuns]);

	useEffect(() => {
		if (slug) loadFindings(slug);
	}, [slug, loadFindings]);

	const onUpdated = useCallback(
		(updated: Finding) => {
			setData((current) =>
				current
					? {
							...current,
							findings: current.findings.map((finding) =>
								finding.id === updated.id ? updated : finding,
							),
						}
					: current,
			);
			reloadRuns();
		},
		[reloadRuns],
	);

	const sync = useCallback(async () => {
		if (!slug) return;
		await api(`/api/runs/${slug}/sync`, { method: "POST" });
		await loadFindings(slug);
		await reloadRuns();
	}, [slug, loadFindings, reloadRuns]);

	const findings = useMemo(() => {
		const needle = filters.query.trim().toLowerCase();
		return (data?.findings ?? [])
			.filter((finding) => filters.showAbsent || finding.present)
			.filter(
				(finding) =>
					filters.decision === "all" || finding.decision === filters.decision,
			)
			.filter(
				(finding) =>
					filters.severity === "all" || finding.severity === filters.severity,
			)
			.filter(
				(finding) =>
					!needle ||
					finding.file.toLowerCase().includes(needle) ||
					finding.rule.toLowerCase().includes(needle) ||
					finding.message.toLowerCase().includes(needle),
			);
	}, [data, filters]);

	const summary = useMemo(() => computeSummary(data?.findings ?? []), [data]);

	return (
		<div class="app">
			<RunList runs={runs} slug={slug} onSelect={setSlug} />
			<main class="main">
				<header class="topbar">
					<div class="tabs">
						<button
							type="button"
							title="Achados da revisão: triagem e decisões por finding"
							class={`btn tab${tab === "findings" ? " active" : ""}`}
							onClick={() => setTab("findings")}
						>
							Findings
						</button>
						<button
							type="button"
							title="Arquivos brutos gerados pela revisão (manifesto, classificação, relatório…)"
							class={`btn tab${tab === "artifacts" ? " active" : ""}`}
							onClick={() => setTab("artifacts")}
						>
							Artefatos
						</button>
					</div>
					{slug && (
						<button
							type="button"
							title="Reancorar: recalcula a linha de cada finding lendo o arquivo atual — use após um auto-fix que deslocou as linhas"
							class="btn sync"
							onClick={sync}
						>
							↻ Reancorar (sync)
						</button>
					)}
				</header>

				<p class="caption">{TAB_CAPTIONS[tab]}</p>
				{error && <p class="error">{error}</p>}

				{slug && tab === "findings" && data && (
					<>
						<SummaryBar summary={summary} />
						<Filters value={filters} onChange={setFilters} />
						<FindingsList
							slug={slug}
							findings={findings}
							onUpdated={onUpdated}
						/>
					</>
				)}
				{slug && tab === "artifacts" && <ArtifactsPanel slug={slug} />}
			</main>
		</div>
	);
}
