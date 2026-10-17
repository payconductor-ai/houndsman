/**
 * App: layout do servidor — sidebar de execuções, header fixo (abas segmentadas,
 * auto-refresh e reancoragem), KPIs, filtros e os painéis de findings/artefatos.
 * Concentra o estado e as chamadas à API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { AutoRefresh } from "./AutoRefresh";
import { api, computeSummary } from "./api";
import { AUTO_REFRESH_MS, TAB_CAPTIONS } from "./constants";
import { Filters, type FiltersState } from "./Filters";
import { FindingsList } from "./FindingsList";
import { Layers, ListIcon, Refresh } from "./icons";
import { RunList } from "./RunList";
import { SummaryBar } from "./SummaryBar";
import type { Finding, FindingsResponse, RunSummary } from "./types";

type Tab = "findings" | "artifacts";

const TABS: { id: Tab; label: string; hint: string }[] = [
	{
		id: "findings",
		label: "Findings",
		hint: "Achados da revisão: triagem e decisões por finding",
	},
	{
		id: "artifacts",
		label: "Artefatos",
		hint: "Arquivos brutos gerados pela revisão (manifesto, classificação, relatório…)",
	},
];

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
	const [lastSync, setLastSync] = useState(() => Date.now());
	const [refreshing, setRefreshing] = useState(false);
	const [syncing, setSyncing] = useState(false);
	/** Refs espelhando estado volátil — o polling não deve recriar o intervalo. */
	const lastSyncRef = useRef(lastSync);
	const slugRef = useRef<string | null>(null);
	const refreshingRef = useRef(false);

	useEffect(() => {
		slugRef.current = slug;
	}, [slug]);

	const markSynced = useCallback(() => {
		lastSyncRef.current = Date.now();
		setLastSync(lastSyncRef.current);
	}, []);

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

	/** Revalidação leve (auto-refresh): runs + findings da run selecionada. */
	const refresh = useCallback(async () => {
		if (refreshingRef.current) return;
		refreshingRef.current = true;
		setRefreshing(true);
		try {
			const { runs: list } = await api<{ runs: RunSummary[] }>("/api/runs");
			setRuns(list);
			const target = slugRef.current ?? list[0]?.slug ?? null;
			if (target) {
				setSlug((current) => current ?? target);
				setData(
					await api<FindingsResponse>(`/api/runs/${target}/findings?all=1`),
				);
			}
			setError("");
		} catch (err) {
			setError(String(err));
		} finally {
			refreshingRef.current = false;
			setRefreshing(false);
			markSynced();
		}
	}, [markSynced]);

	useEffect(() => {
		reloadRuns();
	}, [reloadRuns]);

	useEffect(() => {
		if (slug) loadFindings(slug);
	}, [slug, loadFindings]);

	// Auto-refresh: só o badge mostra o tempo decorrido; a lista só refaz o fetch
	// quando o intervalo estourou (e a aba está visível).
	useEffect(() => {
		const id = setInterval(() => {
			if (document.hidden || refreshingRef.current) return;
			if (Date.now() - lastSyncRef.current >= AUTO_REFRESH_MS) void refresh();
		}, 1000);
		return () => clearInterval(id);
	}, [refresh]);

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
		setSyncing(true);
		try {
			await api(`/api/runs/${slug}/sync`, { method: "POST" });
			await loadFindings(slug);
			await reloadRuns();
			markSynced();
		} finally {
			setSyncing(false);
		}
	}, [slug, loadFindings, reloadRuns, markSynced]);

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

	const branch =
		data?.branch ?? runs.find((run) => run.slug === slug)?.branch ?? slug ?? "";

	return (
		<div class="app">
			<RunList runs={runs} slug={slug} onSelect={setSlug} />
			<main class="main">
				<header class="topbar">
					<div class="segmented">
						{TABS.map((item) => (
							<button
								type="button"
								key={item.id}
								title={item.hint}
								class={`seg-btn${tab === item.id ? " active" : ""}`}
								onClick={() => setTab(item.id)}
							>
								{item.id === "findings" ? (
									<ListIcon size={15} />
								) : (
									<Layers size={15} />
								)}
								{item.label}
							</button>
						))}
					</div>
					<div class="topbar-right">
						<AutoRefresh
							lastSync={lastSync}
							refreshing={refreshing || syncing}
						/>
						{slug && (
							<button
								type="button"
								title="Reancorar: recalcula a linha de cada finding lendo o arquivo atual — use após um auto-fix que deslocou as linhas"
								class="btn sync"
								disabled={syncing}
								onClick={sync}
							>
								<Refresh
									size={15}
									class={`icon${syncing ? " spin" : ""}`}
								/>
								{syncing ? "Reancorando…" : "Reancorar"}
							</button>
						)}
					</div>
				</header>

				<div class="content">
					<div class="page-header">
						{slug && <h1 class="page-title">{branch}</h1>}
						<p class="page-sub">{TAB_CAPTIONS[tab]}</p>
					</div>
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
					{!slug && !error && <p class="empty">Nenhuma execução para triar.</p>}
				</div>
			</main>
		</div>
	);
}
