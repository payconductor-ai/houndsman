/**
 * Resumo final da revisão (`review-resume.md`).
 *
 * Artefato somente-leitura para humanos: não entra em briefs, não é lido pelos
 * watchdogs e não participa de nenhuma etapa seguinte. Une o contexto de
 * negócio da PR aos números técnicos diretos da revisão, com limite de
 * `RESUME_MAX_CHARS`.
 */

import type {
	ContextSummary,
	MergedFinding,
	WatchdogNameResolver,
} from "../report-builder";
import { systemClock } from "../services/clock";
import type { ChurnMap, Severity } from "../types";

/** Teto de caracteres do artefato (inclui cabeçalho e quebras de linha). */
export const RESUME_MAX_CHARS = 2500;

/** Dados de classificação usados no resumo. */
export type ResumeClassification = {
	files: Record<string, { status: string }>;
	watchdogs: Record<string, string[]>;
	churn?: ChurnMap;
	deleted?: string[];
	excludedCount?: number;
};

export type ReviewResumeInput = {
	branch: string;
	/** `YYYY-MM-DD`; default: data corrente do sistema. */
	date?: string;
	context?: ContextSummary | null;
	classification: ResumeClassification;
	findings: readonly MergedFinding[];
	nameOf?: WatchdogNameResolver;
};

const identityName: WatchdogNameResolver = (id) => id;

const STATUS_BY_SEVERITY: Record<"blocking" | "attention" | "clean", string> = {
	blocking: "❌ Mudanças necessárias",
	attention: "⚠️ Aprovado com ressalvas",
	clean: "✅ Aprovado",
};

const STATUS_LABELS: Record<string, string> = {
	added: "adicionado(s)",
	modified: "modificado(s)",
	deleted: "removido(s)",
	renamed: "renomeado(s)",
	copied: "copiado(s)",
	unknown: "alterado(s)",
};

/** Corta o texto em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function plural(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** Conta os status dos arquivos classificados (`added`, `modified`, …). */
function statusCounts(files: ResumeClassification["files"]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const file of Object.values(files)) {
		counts[file.status] = (counts[file.status] ?? 0) + 1;
	}
	return counts;
}

/** Resumo de negócio: contexto da PR; sem ele, o alcance da branch. */
function businessSection(input: ReviewResumeInput): string[] {
	const context = input.context;
	const hasContext =
		context?.available === true &&
		Boolean(
			context.objective ||
				context.motivation ||
				(context.changeSummary && context.changeSummary.length > 0),
		);
	const lines = ["## Resumo de negócio", ""];

	if (!hasContext) {
		const domainCount = Object.keys(input.classification.watchdogs).length;
		lines.push(
			`A branch \`${input.branch}\` altera ${plural(
				Object.keys(input.classification.files).length,
				"arquivo",
				"arquivos",
			)} em ${plural(domainCount, "domínio", "domínios")} de revisão.`,
			"Sem resumo de contexto da PR disponível.",
			"",
		);
		return lines;
	}

	if (context.objective) lines.push(context.objective, "");
	if (context.motivation) lines.push(`**Por quê:** ${context.motivation}`, "");
	if (context.changeSummary && context.changeSummary.length > 0) {
		for (const item of context.changeSummary.slice(0, 4)) {
			lines.push(`- ${truncate(item, 180)}`);
		}
		lines.push("");
	}
	return lines;
}

/** Números objetivos da revisão (arquivos, churn, domínios e achados). */
function numbersSection(
	input: ReviewResumeInput,
	counts: Record<Severity, number>,
	nameOf: WatchdogNameResolver,
): string[] {
	const files = input.classification.files;
	const churn = input.classification.churn ?? {};
	let additions = 0;
	let deletions = 0;
	for (const entry of Object.values(churn)) {
		additions += entry.additions;
		deletions += entry.deletions;
	}

	const statuses = statusCounts(files);
	const statusLabel = Object.entries(statuses)
		.filter(([, total]) => total > 0)
		.map(([status, total]) => `${total} ${STATUS_LABELS[status] ?? status}`)
		.join(" · ");
	const domains =
		Object.keys(input.classification.watchdogs)
			.map((id) => nameOf(id))
			.join(", ") || "—";

	const outOfScope: string[] = [];
	if ((input.classification.excludedCount ?? 0) > 0) {
		outOfScope.push(`${input.classification.excludedCount} excluído(s) da revisão`);
	}
	if ((input.classification.deleted?.length ?? 0) > 0) {
		outOfScope.push(`${input.classification.deleted?.length} deletado(s)`);
	}

	return [
		"## Números",
		"",
		`- **Arquivos:** ${Object.keys(files).length}${statusLabel ? ` — ${statusLabel}` : ""}`,
		`- **Churn:** +${additions} / -${deletions}`,
		`- **Domínios:** ${domains}`,
		`- **Achados:** ${counts.blocking} bloqueante(s) · ${counts.attention} atenção · ${counts.suggestion} sugestão(ões) · ${counts.nit} nit(s)`,
		...(outOfScope.length > 0
			? [`- **Fora do escopo:** ${outOfScope.join(" · ")}`]
			: []),
		"",
	];
}

/** Achados que exigem ação, em formato direto (máximo 5). */
function technicalSection(
	findings: readonly MergedFinding[],
	nameOf: WatchdogNameResolver,
): string[] {
	const relevant = findings
		.filter(
			(finding) =>
				finding.severity === "blocking" || finding.severity === "attention",
		)
		.slice(0, 5);
	const lines = ["## Pontos técnicos", ""];
	if (relevant.length === 0) {
		lines.push("- Nenhum bloqueio ou ponto de atenção.", "");
		return lines;
	}
	for (const finding of relevant) {
		const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
		const watchdogs = finding.watchdogs.map((id) => nameOf(id)).join(", ");
		lines.push(
			`- \`${location}\` — ${truncate(finding.message, 130)}${watchdogs ? ` _(${watchdogs})_` : ""}`,
		);
	}
	lines.push("");
	return lines;
}

/** Garante o teto de caracteres cortando em uma quebra de linha. */
function clamp(markdown: string, max: number): string {
	if (markdown.length <= max) return markdown;
	const head = markdown.slice(0, max - 2);
	const cut = head.lastIndexOf("\n");
	return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}\n…`;
}

/**
 * Renderiza o resumo final. Determinístico e sem chamadas externas: o texto
 * nasce do contexto já disponível e dos findings consolidados.
 */
export function renderReviewResume(input: ReviewResumeInput): string {
	const nameOf = input.nameOf ?? identityName;
	const counts: Record<Severity, number> = {
		blocking: input.findings.filter((f) => f.severity === "blocking").length,
		attention: input.findings.filter((f) => f.severity === "attention").length,
		suggestion: input.findings.filter((f) => f.severity === "suggestion").length,
		nit: input.findings.filter((f) => f.severity === "nit").length,
	};
	const status =
		counts.blocking > 0
			? STATUS_BY_SEVERITY.blocking
			: counts.attention > 0
				? STATUS_BY_SEVERITY.attention
				: STATUS_BY_SEVERITY.clean;

	const lines = [
		`# Resumo da revisão — ${input.branch}`,
		"",
		`**Data:** ${input.date ?? systemClock().slice(0, 10)} · **Status:** ${status}`,
		"",
		...businessSection(input),
		...numbersSection(input, counts, nameOf),
		...technicalSection(input.findings, nameOf),
	];

	return clamp(`${lines.join("\n").trimEnd()}\n`, RESUME_MAX_CHARS);
}
