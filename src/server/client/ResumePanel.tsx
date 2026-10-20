/**
 * Aba "Resumo" (inicial): visão principal da revisão.
 *
 * O texto narrativo vem do artefato `review-resume.md` (Resumo de negócio); os
 * números viram cards a partir do `classification.json`/`manifest.json` e o
 * card de domínios resume os achados por severidade em cada watchdog — assim a
 * UI mostra os mesmos dados do resumo de forma mais organizada, sem duplicar o
 * texto.
 */

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ExternalLink, Layers, Trash } from "./icons";
import { MarkdownBlocks } from "./MarkdownText";
import { api } from "./utils/api";
import { SEVERITY_LABELS, SEVERITY_ORDER } from "./utils/constants";
import { formatRunTime } from "./utils/format";
import { sectionBlocks } from "./utils/markdown";
import type {
	ClassificationArtifact,
	Finding,
	RunDetail,
	RunManifest,
	Severity,
	Summary,
} from "./utils/types";

const STATUS_VIEW = {
	blocking: { label: "Mudanças necessárias", tone: "blocking" },
	attention: { label: "Aprovado com ressalvas", tone: "attention" },
	clean: { label: "Aprovado", tone: "clean" },
} as const;

const STATUS_LABELS: Record<string, string> = {
	added: "adicionado(s)",
	modified: "modificado(s)",
	deleted: "removido(s)",
	renamed: "renomeado(s)",
	copied: "copiado(s)",
	unknown: "alterado(s)",
};

/** Soma do churn quando o manifesto não traz os totais. */
function churnTotals(churn: ClassificationArtifact["churn"]): {
	additions: number;
	deletions: number;
} {
	let additions = 0;
	let deletions = 0;
	for (const entry of Object.values(churn ?? {})) {
		additions += entry.additions;
		deletions += entry.deletions;
	}
	return { additions, deletions };
}

function ResumeKpi({
	label,
	value,
	hint,
	tone,
}: {
	label: string;
	value: ComponentChildren;
	hint?: string;
	tone?: "blocking" | "attention" | "total";
}) {
	return (
		<div class={`kpi${tone ? ` kpi-${tone}` : ""}`} title={hint}>
			<span class="kpi-label">{label}</span>
			<span class="kpi-value">{value}</span>
			{hint && <span class="kpi-hint">{hint}</span>}
		</div>
	);
}

export function ResumePanel({
	slug,
	branch,
	findings,
	summary,
	onRequestDelete,
}: {
	slug: string;
	branch: string;
	findings: Finding[];
	summary: Summary;
	onRequestDelete: () => void;
}) {
	const [resume, setResume] = useState("");
	const [detail, setDetail] = useState<RunDetail | null>(null);
	const [classification, setClassification] = useState<ClassificationArtifact | null>(
		null,
	);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError("");
		Promise.all([
			api<RunDetail>(`/api/runs/${slug}`).catch(() => null),
			fetch(`/api/runs/${slug}/artifacts/review-resume.md`)
				.then((res) => (res.ok ? res.text() : ""))
				.catch(() => ""),
			api<ClassificationArtifact>(
				`/api/runs/${slug}/artifacts/classification.json`,
			).catch(() => null),
		])
			.then(([runDetail, markdown, classified]) => {
				if (cancelled) return;
				setDetail(runDetail);
				setResume(markdown);
				setClassification(classified);
			})
			.catch((err) => {
				if (!cancelled) setError(String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [slug]);

	const manifest: RunManifest | null = detail?.manifest ?? null;
	const business = useMemo(() => sectionBlocks(resume, "Resumo de negócio"), [resume]);
	const status =
		summary.bySeverity.blocking > 0
			? STATUS_VIEW.blocking
			: summary.bySeverity.attention > 0
				? STATUS_VIEW.attention
				: STATUS_VIEW.clean;

	const files = classification?.files ?? {};
	const fileCount = Object.keys(files).length;
	/** Arquivos com conteúdo para revisar (deletados não entram no escopo). */
	const reviewableCount = Object.values(files).filter(
		(file) => file.status !== "deleted",
	).length;
	const statuses = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const file of Object.values(files)) {
			counts[file.status] = (counts[file.status] ?? 0) + 1;
		}
		return counts;
	}, [files]);
	const statusLabel = Object.entries(statuses)
		.map(([state, total]) => `${total} ${STATUS_LABELS[state] ?? state}`)
		.join(" · ");
	const churn = manifest?.churn ?? churnTotals(classification?.churn);
	const pr = manifest?.context?.source;
	const reviewedCount = useMemo(() => {
		const set = new Set<string>();
		for (const domain of manifest?.watchdogs ?? []) {
			for (const file of domain.files) set.add(file);
		}
		return set.size;
	}, [manifest]);
	const coverage =
		manifest && reviewableCount > 0
			? `${Math.min(100, Math.round((reviewedCount / reviewableCount) * 100))}%`
			: "—";

	const domains = useMemo(() => {
		const base = manifest?.watchdogs?.length
			? manifest.watchdogs.map((domain) => ({
					id: domain.id,
					name: domain.name || domain.id,
					files: domain.files.length,
					overflow: domain.overflow,
				}))
			: (detail?.watchdogs ?? []).map((id) => ({
					id,
					name: id,
					files: 0,
					overflow: 0,
				}));

		return base
			.map((domain) => {
				const bySeverity: Record<Severity, number> = {
					blocking: 0,
					attention: 0,
					suggestion: 0,
					nit: 0,
				};
				for (const finding of findings) {
					if (!finding.watchdogIds.includes(domain.id)) continue;
					bySeverity[finding.severity] += 1;
				}
				const total = SEVERITY_ORDER.reduce(
					(sum, severity) => sum + bySeverity[severity],
					0,
				);
				return { ...domain, bySeverity, total };
			})
			.sort(
				(a, b) =>
					b.bySeverity.blocking - a.bySeverity.blocking ||
					b.bySeverity.attention - a.bySeverity.attention ||
					b.total - a.total ||
					a.name.localeCompare(b.name),
			);
	}, [manifest, detail, findings]);

	return (
		<div class="resume">
			<section class="resume-hero">
				<div class="resume-hero-text">
					<span class="resume-kicker">Resumo principal</span>
					<h2 class="resume-title">{branch}</h2>
					<p class="resume-meta">
						{manifest?.generatedAt && (
							<span>{formatRunTime(manifest.generatedAt)}</span>
						)}
						{domains.length > 0 && (
							<span>
								{domains.length}{" "}
								{domains.length === 1 ? "domínio" : "domínios"}
							</span>
						)}
						{pr?.url ? (
							<a
								class="resume-pr"
								href={pr.url}
								target="_blank"
								rel="noreferrer"
							>
								{pr.number ? `PR #${pr.number}` : "Abrir PR"}
								<ExternalLink size={12} />
							</a>
						) : pr?.number ? (
							<span>PR #{pr.number}</span>
						) : null}
					</p>
				</div>
				<div class="resume-hero-side">
					<span class={`resume-status ${status.tone}`}>{status.label}</span>
					<button
						type="button"
						class="btn danger"
						title="Excluir esta execução, seus findings e artefatos locais"
						onClick={onRequestDelete}
					>
						<Trash size={14} />
						Excluir
					</button>
				</div>
			</section>

			{error && <p class="error">{error}</p>}

			<div class="kpis resume-kpis">
				<ResumeKpi
					label="Arquivos"
					value={fileCount}
					hint={statusLabel || "sem classificação"}
				/>
				<ResumeKpi
					label="Churn"
					value={
						<>
							<span class="churn-add">+{churn.additions}</span>
							<span class="churn-sep">/</span>
							<span class="churn-del">-{churn.deletions}</span>
						</>
					}
					hint="linhas adicionadas / removidas"
				/>
				<ResumeKpi
					label="Cobertura"
					value={coverage}
					hint={
						reviewableCount > 0
							? `${reviewedCount}/${reviewableCount} revisáveis no escopo`
							: "sem classificação"
					}
				/>
				<ResumeKpi
					label="Achados"
					value={summary.total}
					hint={`${summary.bySeverity.blocking} bloqueantes · ${summary.bySeverity.attention} atenção`}
					tone={
						summary.bySeverity.blocking > 0
							? "blocking"
							: summary.bySeverity.attention > 0
								? "attention"
								: "total"
					}
				/>
			</div>

			<div class="resume-grid">
				<section class="resume-card">
					<h3 class="resume-card-title">Resumo de negócio</h3>
					{loading ? (
						<p class="empty">Carregando resumo…</p>
					) : business.length > 0 ? (
						<div class="resume-narrative">
							<MarkdownBlocks blocks={business} />
						</div>
					) : (
						<p class="empty">
							O resumo narrativo ainda não foi gerado para esta run. Rode o{" "}
							<code>--finalize</code> para criar{" "}
							<code>review-resume.md</code>.
						</p>
					)}
				</section>

				<section class="resume-card">
					<div class="resume-card-head">
						<h3 class="resume-card-title">Domínios</h3>
						{domains.length > 0 && (
							<span class="resume-card-count">{domains.length}</span>
						)}
					</div>
					{domains.length > 0 ? (
						<ul class="resume-domains">
							{domains.map((domain) => (
								<li class="resume-domain" key={domain.id}>
									<div class="resume-domain-head">
										<span class="resume-domain-name">
											{domain.name}
										</span>
										<span class="resume-domain-files">
											{domain.files > 0
												? `${domain.files} ${domain.files === 1 ? "arquivo" : "arquivos"}`
												: "—"}
											{domain.overflow > 0
												? ` · ${domain.overflow} fora do orçamento`
												: ""}
										</span>
									</div>
									<div class="resume-domain-sev">
										{domain.total === 0 ? (
											<span class="resume-domain-ok">
												Sem achados
											</span>
										) : (
											SEVERITY_ORDER.filter(
												(severity) =>
													domain.bySeverity[severity] > 0,
											).map((severity) => (
												<span
													class={`sev-badge sev-${severity}`}
													key={severity}
												>
													{SEVERITY_LABELS[severity]}{" "}
													{domain.bySeverity[severity]}
												</span>
											))
										)}
									</div>
								</li>
							))}
						</ul>
					) : (
						<p class="empty">Nenhum domínio ativo na revisão.</p>
					)}
				</section>
			</div>
		</div>
	);
}
