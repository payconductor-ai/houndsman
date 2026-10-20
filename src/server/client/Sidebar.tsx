/**
 * Sidebar: logo do houndsman + abas `Execuções` e `PR's`.
 *
 * A aba de execuções mantém a lista de runs (status, data e findings). A aba de
 * PRs lista as PRs abertas via `gh`, permite abrir a run correspondente e faz
 * checkout somente quando a árvore de trabalho está limpa.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
	BranchIcon,
	Clock,
	GitHub,
	GitPullRequest,
	ListIcon,
	Refresh,
	Sparkles,
	Spinner,
} from "./icons";
import { api } from "./utils/api";
import { describeRunStatus } from "./utils/constants";
import { formatRunTime } from "./utils/format";
import type {
	CheckoutResponse,
	PrListItem,
	PrListResponse,
	PrWorktreeResponse,
	RunSummary,
	WorktreeState,
} from "./utils/types";

type SidebarView = "runs" | "prs";

const REVIEW_LABELS: Record<string, string> = {
	APPROVED: "aprovada",
	CHANGES_REQUESTED: "mudanças",
	REVIEW_REQUIRED: "revisão pendente",
};

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

function PrItem({
	pr,
	currentBranch,
	worktree,
	busy,
	confirming,
	worktreeBusy,
	onConfirm,
	onCancel,
	onCheckout,
	onCreateWorktree,
	onSelectRun,
}: {
	pr: PrListItem;
	currentBranch: string | null;
	worktree: WorktreeState;
	busy: boolean;
	confirming: boolean;
	worktreeBusy: boolean;
	onConfirm: (number: number) => void;
	onCancel: () => void;
	onCheckout: (pr: PrListItem) => void;
	onCreateWorktree: (pr: PrListItem) => void;
	onSelectRun: (slug: string) => void;
}) {
	const isCurrent = currentBranch === pr.headRefName;
	const runSlug = pr.runSlug;
	const review = pr.reviewDecision ? REVIEW_LABELS[pr.reviewDecision] : undefined;
	return (
		<article class={`pr${isCurrent ? " current" : ""}`}>
			<div class="pr-head">
				<GitPullRequest size={14} class="pr-icon" />
				<span class="pr-number">#{pr.number}</span>
				{pr.isDraft && <span class="tag">draft</span>}
				{isCurrent && <span class="pr-current">atual</span>}
				<span class="spacer" />
				{pr.updatedAt && (
					<span class="run-when">
						<Clock size={12} />
						{formatRunTime(pr.updatedAt)}
					</span>
				)}
			</div>
			<p class="pr-title">{pr.title}</p>
			<p class="pr-meta">
				<span class="pr-branch">{pr.headRefName}</span>
				<span class="pr-arrow">→</span>
				<span>{pr.baseRefName || "—"}</span>
				<span>· {pr.author}</span>
			</p>
			{review && <p class={`pr-review pr-review-${pr.reviewDecision}`}>{review}</p>}
			{pr.worktreePath && (
				<p class="pr-worktree" title={pr.worktreePath}>
					Worktree: <code>{pr.worktreePath}</code>
				</p>
			)}
			<div class="pr-actions">
				{runSlug && (
					<button
						type="button"
						class="pr-btn"
						title="Abrir a run local desta branch"
						onClick={() => onSelectRun(runSlug)}
					>
						Abrir run
					</button>
				)}
				{!pr.worktreePath && (
					<button
						type="button"
						class="pr-btn"
						disabled={busy || worktreeBusy}
						title={`Criar um worktree dedicado para ${pr.headRefName} (revisão paralela)`}
						onClick={() => onCreateWorktree(pr)}
					>
						{worktreeBusy ? (
							<Spinner size={12} class="icon spin" />
						) : (
							"Worktree"
						)}
					</button>
				)}
				{pr.url && (
					<a
						class="pr-btn"
						href={pr.url}
						target="_blank"
						rel="noreferrer"
						title="Abrir a PR no GitHub"
					>
						<GitHub size={12} /> GitHub
					</a>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							class="pr-btn danger"
							disabled={busy}
							title="Confirmar checkout da PR"
							onClick={() => onCheckout(pr)}
						>
							{busy ? <Spinner size={12} class="icon spin" /> : "Confirmar"}
						</button>
						<button
							type="button"
							class="pr-btn"
							disabled={busy}
							onClick={onCancel}
						>
							Cancelar
						</button>
					</>
				) : (
					<button
						type="button"
						class="pr-btn"
						disabled={!worktree.clean || busy}
						title={
							worktree.clean
								? `Fazer checkout da branch ${pr.headRefName}`
								: "Há alterações não commitadas — faça commit ou stash antes"
						}
						onClick={() => onConfirm(pr.number)}
					>
						Checkout
					</button>
				)}
			</div>
		</article>
	);
}

export function Sidebar({
	runs,
	slug,
	onSelect,
	onRefreshRuns,
}: {
	runs: RunSummary[];
	slug: string | null;
	onSelect: (slug: string) => void;
	onRefreshRuns: () => void;
}) {
	const [view, setView] = useState<SidebarView>("runs");
	const [data, setData] = useState<PrListResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState<number | null>(null);
	const [worktreeBusy, setWorktreeBusy] = useState<number | null>(null);
	const [confirming, setConfirming] = useState<number | null>(null);
	const requested = useRef(false);

	const loadPrs = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			setData(await api<PrListResponse>("/api/prs"));
		} catch (err) {
			setError(String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (view !== "prs" || requested.current) return;
		requested.current = true;
		void loadPrs();
	}, [view, loadPrs]);

	const checkout = useCallback(
		async (pr: PrListItem) => {
			setBusy(pr.number);
			setError("");
			setNotice("");
			try {
				const result = await api<CheckoutResponse>("/api/prs/checkout", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ number: pr.number }),
				});
				if (!result.ok) {
					if (result.reason === "dirty") {
						setData((current) =>
							current
								? {
										...current,
										worktree: {
											...current.worktree,
											clean: false,
											changes:
												result.changes?.length ??
												current.worktree.changes,
											sample:
												result.changes ?? current.worktree.sample,
										},
									}
								: current,
						);
					}
					setError(
						result.reason === "dirty"
							? `Checkout bloqueado: ${result.detail}`
							: result.detail,
					);
					return;
				}
				setConfirming(null);
				setNotice(
					`Checkout de #${pr.number} concluído${
						result.branch ? ` — ${result.branch}` : ""
					}.`,
				);
				await loadPrs();
				onRefreshRuns();
				if (pr.runSlug) onSelect(pr.runSlug);
			} catch (err) {
				setError(String(err));
			} finally {
				setBusy(null);
			}
		},
		[loadPrs, onRefreshRuns, onSelect],
	);
	const createWorktree = useCallback(
		async (pr: PrListItem) => {
			setWorktreeBusy(pr.number);
			setError("");
			setNotice("");
			try {
				const result = await api<PrWorktreeResponse>("/api/prs/worktree", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ number: pr.number }),
				});
				if (!result.ok) {
					setError(result.detail);
					return;
				}
				setNotice(
					`Worktree de #${pr.number} em ${result.path}. ` +
						`Rode \`houndsman --pr ${pr.number}\` para revisar em paralelo.`,
				);
				await loadPrs();
			} catch (err) {
				setError(String(err));
			} finally {
				setWorktreeBusy(null);
			}
		},
		[loadPrs],
	);
	return (
		<aside class="sidebar">
			<div class="brand">
				<img class="logo" src="/assets/logo.png" alt="" />
				<div>
					<h1>Houndsman</h1>
					<p class="sub">Revisões e triagem</p>
				</div>
			</div>

			<div class="side-tabs" role="tablist" aria-label="Navegação lateral">
				<button
					type="button"
					role="tab"
					aria-selected={view === "runs"}
					class={`side-tab${view === "runs" ? " active" : ""}`}
					onClick={() => setView("runs")}
				>
					<ListIcon size={13} /> Execuções
					<span class="side-count">{runs.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={view === "prs"}
					class={`side-tab${view === "prs" ? " active" : ""}`}
					onClick={() => setView("prs")}
				>
					<GitPullRequest size={13} /> PR's
				</button>
			</div>

			{view === "runs" ? (
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
			) : (
				<>
					<div class="pr-toolbar">
						<p class="section-label">PRs abertas</p>
						<button
							type="button"
							class="icon-btn"
							title="Atualizar lista de PRs"
							disabled={loading}
							onClick={() => void loadPrs()}
						>
							<Refresh
								size={13}
								class={loading ? "icon spin" : undefined}
							/>
						</button>
					</div>

					{error && <p class="error">{error}</p>}
					{notice && <p class="pr-notice">{notice}</p>}
					{data && !data.available && (
						<p class="empty">
							GitHub indisponível
							{data.reason ? `: ${data.reason}` : "."}
						</p>
					)}
					{data && !data.worktree.available && (
						<p class="empty">Não foi possível ler o estado do git.</p>
					)}
					{data?.worktree.available && !data.worktree.clean && (
						<p class="pr-warning">
							{data.worktree.changes} alteração(ões) não commitada(s) —
							checkout bloqueado até limpar a árvore.
						</p>
					)}
					{data?.currentBranch && (
						<p class="pr-current-branch">
							Branch atual: <code>{data.currentBranch}</code>
						</p>
					)}

					<nav class="prs" aria-label="Pull requests abertas">
						{loading && !data && <p class="empty">Carregando PRs…</p>}
						{data?.available && data.prs.length === 0 && (
							<p class="empty">Nenhuma PR aberta.</p>
						)}
						{data?.prs.map((pr) => (
							<PrItem
								key={pr.number}
								pr={pr}
								currentBranch={data.currentBranch}
								worktree={data.worktree}
								busy={busy !== null}
								confirming={confirming === pr.number}
								worktreeBusy={worktreeBusy === pr.number}
								onConfirm={setConfirming}
								onCancel={() => setConfirming(null)}
								onCheckout={checkout}
								onCreateWorktree={createWorktree}
								onSelectRun={onSelect}
							/>
						))}
					</nav>
				</>
			)}
		</aside>
	);
}
