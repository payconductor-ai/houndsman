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

/** Limiar de inatividade da correção para exibir timeout (display-only). */
export const STATUS_TIMEOUT_MS = 10 * 60 * 1000;

/** Revisão despacha subagentes em ondas longas — janela maior que a correção. */
export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/** Intervalo do polling da UI (o badge conta o tempo desde a última sync). */
export const AUTO_REFRESH_MS = 10_000;

export type RunStatusView = { kind: string; label: string; timeout: boolean };

/**
 * View do status de uma run — timeout só existe quando há um heartbeat de
 * execução (`reviewing`/`fixing`). `updatedAt` muda com triagem/sync e não
 * serve para provar que a skill está rodando.
 */
export function describeRunStatus(
	run: RunSummary,
	now: number = Date.now(),
): RunStatusView | null {
	const status = run.status;
	if (!status) return null;
	const active = status === "reviewing" || status === "fixing";
	if (!active) {
		return { kind: status, label: RUN_STATUS_LABELS[status], timeout: false };
	}

	// Sem heartbeat não há execução conhecida: evita o falso "timeout".
	const heartbeat = run.heartbeatAt ? Date.parse(run.heartbeatAt) : Number.NaN;
	if (!Number.isFinite(heartbeat)) return null;

	const timeoutMs = status === "reviewing" ? REVIEW_TIMEOUT_MS : STATUS_TIMEOUT_MS;
	if (now - heartbeat > timeoutMs) {
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
	"resume",
	"domain-review",
	"verify",
	"brief",
	"manifest",
	"classification",
	"candidates",
	"ast",
	"ast-impact",
	"ai",
	"ai-usage",
	"ai-brief",
	"harness-transcript",
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
		resume: { key: "report", label: "Relatórios", order: 0 },
		"domain-review": { key: "report", label: "Relatórios", order: 0 },
		verify: { key: "verify", label: "Verificação", order: 1 },
		brief: { key: "brief", label: "Briefs (auditoria)", order: 2 },
		manifest: { key: "core", label: "Núcleo da revisão", order: 3 },
		classification: { key: "core", label: "Núcleo da revisão", order: 3 },
		candidates: { key: "core", label: "Núcleo da revisão", order: 3 },
		ast: { key: "core", label: "Núcleo da revisão", order: 3 },
		"ast-impact": { key: "core", label: "Núcleo da revisão", order: 3 },
		ai: { key: "ai", label: "IA e harness", order: 4 },
		"ai-usage": { key: "ai", label: "IA e harness", order: 4 },
		"ai-brief": { key: "ai", label: "IA e harness", order: 4 },
		"harness-transcript": { key: "ai", label: "IA e harness", order: 4 },
		context: { key: "context", label: "Contexto da PR", order: 5 },
		"context-brief": { key: "context", label: "Contexto da PR", order: 5 },
		"context-summary": { key: "context", label: "Contexto da PR", order: 5 },
		"finding-report": { key: "other", label: "Outros", order: 6 },
		other: { key: "other", label: "Outros", order: 6 },
	};

/** Rótulo curto do tipo (badge do item). */
export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
	review: "relatório",
	resume: "resumo",
	"domain-review": "domínio",
	verify: "verify",
	brief: "brief",
	manifest: "manifesto",
	classification: "classificação",
	candidates: "jev",
	ast: "ast",
	"ast-impact": "impacto",
	ai: "ia",
	"ai-usage": "uso ia",
	"ai-brief": "plano ia",
	"harness-transcript": "transcript",
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
		case "resume":
			return "Resumo final da revisão: visão de negócio e pontos técnicos diretos (leitura humana).";
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
		case "ast":
			return "Fatos estruturais e delta por arquivo (símbolos, imports, exports e assinaturas).";
		case "ast-impact":
			return "Impacto reverso: arquivos que importam os alterados e exports públicos modificados.";
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

/** `true` se o conteúdo deve ser renderizado como markdown. */
export function isMarkdownArtifact(meta: ArtifactMeta | undefined): boolean {
	if (!meta) return false;
	return (
		meta.contentType.includes("markdown") || meta.name.toLowerCase().endsWith(".md")
	);
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
	resume: "Resumo principal da revisão: o que muda em termos de negócio, números diretos (arquivos, churn, domínios) e os pontos técnicos que exigem ação.",
	findings:
		"Triagem dos achados da revisão: decida Executar, Ignorar ou deixe Pendente — o comentário orienta o auto-fix. Agente: houndsman findings list --decision pending --json · findings done <id>.",
	artifacts:
		"Artefatos persistidos da run: relatórios, briefs de auditoria, manifesto, classificação, Jev, contexto da PR e verificação. JSON com destaque de sintaxe; markdown renderizado com highlight de código.",
	comments:
		"Comentários da PR vinculada à branch: threads de revisão agrupadas por arquivo e comentários gerais. Carregados sob demanda ao abrir esta aba.",
} as const;
