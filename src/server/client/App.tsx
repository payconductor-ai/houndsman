/**
 * App: layout do servidor — sidebar de execuções, header fixo (abas segmentadas,
 * auto-refresh e reancoragem), KPIs, filtros e os painéis de resumo/findings/
 * artefatos. Concentra o estado e as chamadas à API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { AutoRefresh } from "./AutoRefresh";
import { CommentsPanel } from "./CommentsPanel";
import { DeleteRunModal } from "./DeleteRunModal";
import { Filters, type FiltersState } from "./Filters";
import { FindingsList } from "./FindingsList";
import { FileText, Layers, ListIcon, MessageSquare, Refresh, Send } from "./icons";
import { ResumePanel } from "./ResumePanel";
import { Sidebar } from "./Sidebar";
import { SubmitModal } from "./SubmitModal";
import { SummaryBar } from "./SummaryBar";
import { api, computeSummary } from "./utils/api";
import { AUTO_REFRESH_MS, TAB_CAPTIONS } from "./utils/constants";
import type {
	DeleteRunResponse,
	EditorContext,
	Finding,
	FindingsResponse,
	RunSummary,
} from "./utils/types";

type Tab = "resume" | "findings" | "artifacts" | "comments";

const TABS: { id: Tab; label: string; hint: string }[] = [
	{
		id: "resume",
		label: "Resumo",
		hint: "Visão principal da revisão: negócio, números e pontos técnicos",
	},
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
	{
		id: "comments",
		label: "Comentários",
		hint: "Comentários da PR: threads de revisão e comentários gerais (carregados ao abrir a aba)",
	},
];

function TabIcon({ id }: { id: Tab }) {
	if (id === "resume") return <FileText size={15} />;
	if (id === "findings") return <ListIcon size={15} />;
	if (id === "artifacts") return <Layers size={15} />;
	return <MessageSquare size={15} />;
}

export function App() {
	const [runs, setRuns] = useState<RunSummary[]>([]);
	const [slug, setSlug] = useState<string | null>(null);
	const [data, setData] = useState<FindingsResponse | null>(null);
	const [tab, setTab] = useState<Tab>("resume");
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
	const [submitOpen, setSubmitOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	/** Editor detectado pelo servidor — base dos links de código. */
	const [editor, setEditor] = useState<EditorContext>({ kind: "vscode" });
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
		api<EditorContext>("/api/editor")
			.then(setEditor)
			.catch(() => {
				// fail-open: mantém o fallback VS Code.
			});
	}, []);

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

	/** Após enviar a revisão: a triagem ganhou o vínculo remoto — recarrega. */
	const afterSubmit = useCallback(() => {
		if (slugRef.current) void loadFindings(slugRef.current);
		void reloadRuns();
	}, [loadFindings, reloadRuns]);

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

	const selectedRun = runs.find((run) => run.slug === slug) ?? null;
	const branch = data?.branch ?? selectedRun?.branch ?? slug ?? "";

	/** Após excluir: limpa a seleção e escolhe a próxima run da lista. */
	const afterDelete = useCallback((result: DeleteRunResponse) => {
		setDeleteOpen(false);
		setData(null);
		setSlug(null);
		if (result.warning) {
			setError(
				`Execução excluída, mas o worktree não foi removido: ${result.warning}`,
			);
		} else {
			setError("");
		}
		api<{ runs: RunSummary[] }>("/api/runs")
			.then(({ runs: list }) => {
				setRuns(list);
				setSlug(list[0]?.slug ?? null);
			})
			.catch((err) => setError(String(err)));
	}, []);

	return (
		<div class="app">
			<Sidebar
				runs={runs}
				slug={slug}
				onSelect={setSlug}
				onRefreshRuns={() => void reloadRuns()}
			/>
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
								<TabIcon id={item.id} />
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
						<div class="page-header-text">
							{slug && <h1 class="page-title">{branch}</h1>}
							<p class="page-sub">{TAB_CAPTIONS[tab]}</p>
						</div>
						{slug && tab === "findings" && data && (
							<div class="page-header-actions">
								<button
									type="button"
									class="btn submit-review"
									title="Publicar os findings selecionados como comentários na PR (via gh)"
									onClick={() => setSubmitOpen(true)}
								>
									<Send size={15} />
									Enviar revisão
								</button>
							</div>
						)}
					</div>
					{error && <p class="error">{error}</p>}

					{slug && tab === "resume" && data && (
						<ResumePanel
							slug={slug}
							branch={branch}
							findings={data.findings}
							summary={summary}
							onRequestDelete={() => setDeleteOpen(true)}
						/>
					)}
					{slug && tab === "findings" && data && (
						<>
							<SummaryBar summary={summary} />
							<Filters value={filters} onChange={setFilters} />
							<FindingsList
								slug={slug}
								findings={findings}
								editor={editor}
								onUpdated={onUpdated}
							/>
						</>
					)}
					{slug && tab === "artifacts" && <ArtifactsPanel slug={slug} />}
					{slug && tab === "comments" && (
						<CommentsPanel slug={slug} editor={editor} />
					)}
					{!slug && !error && <p class="empty">Nenhuma execução para triar.</p>}
				</div>
				{slug && (
					<>
						<SubmitModal
							slug={slug}
							branch={branch}
							open={submitOpen}
							onClose={() => setSubmitOpen(false)}
							onSubmitted={afterSubmit}
						/>
						<DeleteRunModal
							slug={slug}
							branch={branch}
							worktreePath={selectedRun?.worktreePath}
							open={deleteOpen}
							onClose={() => setDeleteOpen(false)}
							onDeleted={afterDelete}
						/>
					</>
				)}
			</main>
		</div>
	);
}
