/**
 * Constantes de apresentação do cliente (labels, ordem, emojis).
 */

import type {
	ArtifactKind,
	ArtifactMeta,
	Decision,
	ExecState,
	RunStatus,
	RunSummary,
	Severity,
} from "./types";

/** Rótulo de exibição de cada severidade (o CSS dá a cor via `sev-<nivel>`). */
export const SEVERITY_LABELS: Record<Severity, string> = {
	blocking: "Blocking",
	attention: "Attention",
	suggestion: "Suggestion",
	nit: "Nit",
};

export const SEVERITY_ORDER: Severity[] = ["blocking", "attention", "suggestion", "nit"];

export const DECISIONS: Decision[] = ["pending", "execute", "ignore"];

export const DECISION_LABELS: Record<Decision, string> = {
	pending: "Pendente",
	execute: "Executar",
	ignore: "Ignorar",
};

export const EXEC_STATES: ExecState[] = ["pending", "in_progress", "done", "stale"];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
	reviewing: "Revisando",
	review_done: "Revisão pronta",
	fixing: "Corrigindo",
	fix_done: "Correção pronta",
};

/** Limiar de inatividade para exibir timeout (display-only; não é status). */
export const STATUS_TIMEOUT_MS = 10 * 60 * 1000;

/** Intervalo do polling da UI (o badge conta o tempo desde a última sync). */
export const AUTO_REFRESH_MS = 10_000;

export type RunStatusView = { kind: string; label: string; timeout: boolean };

/** View do status de uma run — label; vira timeout quando ativo e sem ping recente. */
export function describeRunStatus(
	run: RunSummary,
	now: number = Date.now(),
): RunStatusView | null {
	const status = run.status;
	if (!status) return null;
	const active = status === "reviewing" || status === "fixing";
	const updated = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
	if (active && Number.isFinite(updated) && now - updated > STATUS_TIMEOUT_MS) {
		return {
			kind: "timeout",
			label: status === "reviewing" ? "Timeout na revisão" : "Timeout na correção",
			timeout: true,
		};
	}
	return { kind: status, label: RUN_STATUS_LABELS[status], timeout: false };
}

/** Ordem canônica dos tipos de artefato na lista da UI. */
const KIND_ORDER: ArtifactKind[] = [
	"review",
	"domain-review",
	"verify",
	"brief",
	"manifest",
	"classification",
	"candidates",
	"context",
	"context-brief",
	"context-summary",
	"finding-report",
	"other",
];

/** Grupo visual de cada tipo (relatórios, briefs, núcleo, contexto…). */
const GROUP_BY_KIND: Record<ArtifactKind, { key: string; label: string; order: number }> =
	{
		review: { key: "report", label: "Relatórios", order: 0 },
		"domain-review": { key: "report", label: "Relatórios", order: 0 },
		verify: { key: "verify", label: "Verificação", order: 1 },
		brief: { key: "brief", label: "Briefs (auditoria)", order: 2 },
		manifest: { key: "core", label: "Núcleo da revisão", order: 3 },
		classification: { key: "core", label: "Núcleo da revisão", order: 3 },
		candidates: { key: "core", label: "Núcleo da revisão", order: 3 },
		context: { key: "context", label: "Contexto da PR", order: 4 },
		"context-brief": { key: "context", label: "Contexto da PR", order: 4 },
		"context-summary": { key: "context", label: "Contexto da PR", order: 4 },
		"finding-report": { key: "other", label: "Outros", order: 5 },
		other: { key: "other", label: "Outros", order: 5 },
	};

/** Rótulo curto do tipo (badge do item). */
export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
	review: "relatório",
	"domain-review": "domínio",
	verify: "verify",
	brief: "brief",
	manifest: "manifesto",
	classification: "classificação",
	candidates: "jev",
	context: "contexto",
	"context-brief": "brief ctx",
	"context-summary": "resumo ctx",
	"finding-report": "findings",
	other: "outro",
};

/** Nome exibido (briefs perdem o prefixo `briefs/`). */
export function displayArtifactName(meta: ArtifactMeta): string {
	return meta.name.startsWith("briefs/")
		? meta.name.slice("briefs/".length)
		: meta.name;
}

/** Descrição curta do artefato (cabeçalho do painel). */
export function describeArtifact(meta: ArtifactMeta): string {
	switch (meta.kind) {
		case "review":
			return "Relatório consolidado da revisão — o entregável.";
		case "domain-review":
			return "Relatório isolado do domínio: achados daquele watchdog.";
		case "verify":
			return "Resultado do `findings verify` (resolvidos, persistentes e incertos).";
		case "brief":
			return "Instruções enviadas ao subagente (auditoria do prompt).";
		case "manifest":
			return "Resumo da execução: watchdogs, arquivos, orçamento, churn, Jev e contexto.";
		case "classification":
			return "Classificação do diff: watchdogs ativados por arquivo, status (A/M/D/R) e churn.";
		case "candidates":
			return "Indícios da pré-análise Jev (regra + arquivo + confiança) — não são achados.";
		case "context":
			return "Payload bruto da PR coletado via `gh` (ou marcador de indisponível).";
		case "context-brief":
			return "Brief do subagente que resume o contexto da PR.";
		case "context-summary":
			return "Resumo da PR (objetivo, motivação e alterações) gerado no Passo 0.";
		default:
			return meta.name;
	}
}

/** `true` se o conteúdo deve ser renderizado com destaque de JSON. */
export function isJsonArtifact(meta: ArtifactMeta | undefined): boolean {
	if (!meta) return false;
	return meta.contentType.includes("json") || meta.name.toLowerCase().endsWith(".json");
}

/** Agrupa os artefatos para a navegação lateral (ordem estável). */
export function groupArtifacts(
	items: ArtifactMeta[],
): { key: string; label: string; items: ArtifactMeta[] }[] {
	const groups = new Map<
		string,
		{ key: string; label: string; order: number; items: ArtifactMeta[] }
	>();
	for (const item of items) {
		const meta = GROUP_BY_KIND[item.kind] ?? GROUP_BY_KIND.other;
		const group = groups.get(meta.key) ?? {
			key: meta.key,
			label: meta.label,
			order: meta.order,
			items: [],
		};
		group.items.push(item);
		groups.set(meta.key, group);
	}
	return [...groups.values()]
		.sort((a, b) => a.order - b.order)
		.map((group) => ({
			key: group.key,
			label: group.label,
			items: group.items.sort(
				(a, b) =>
					KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
					a.name.localeCompare(b.name),
			),
		}));
}

/** Legenda única de cada aba (explica o que a aba é; mostrada quando selecionada). */
export const TAB_CAPTIONS = {
	findings:
		"Triagem dos achados da revisão: decida Executar, Ignorar ou deixe Pendente — o comentário orienta o auto-fix. Agente: houndsman findings list --decision pending --json · findings done <id>.",
	artifacts:
		"Artefatos persistidos da run: relatórios, briefs de auditoria, manifesto, classificação, Jev, contexto da PR e verificação. JSON com destaque de sintaxe.",
} as const;
