/**
 * Resumo final da revisão (`review-resume.md`).
 *
 * Artefato somente-leitura para humanos: não entra em briefs, não é lido pelos
 * watchdogs e não participa de nenhuma etapa seguinte. Une o contexto de
 * negócio da PR aos pontos técnicos estruturais da revisão, com limite de
 * `RESUME_MAX_CHARS`.
 */

import { type BusinessSummary, renderBusinessLines } from "../business-summary";
import type { ContextSummary, MergedFinding } from "../report-builder";
import { systemClock } from "../services/clock";
import type { TechnicalSummary } from "../technical-summary";

/** Teto de caracteres do artefato (inclui cabeçalho e quebras de linha). */
export const RESUME_MAX_CHARS = 5000;

/** Dados de classificação usados no resumo. */
export type ResumeClassification = {
	files: Record<string, { status: string }>;
	watchdogs: Record<string, string[]>;
};

export type ReviewResumeInput = {
	branch: string;
	/** `YYYY-MM-DD`; default: data corrente do sistema. */
	date?: string;
	context?: ContextSummary | null;
	/** Modelo de intenção da PR (negócio). */
	business?: BusinessSummary | null;
	classification: ResumeClassification;
	findings: readonly MergedFinding[];
	/** Pontos técnicos estruturais (não achados). */
	technical?: TechnicalSummary | null;
};

const STATUS_BY_SEVERITY: Record<"blocking" | "attention" | "clean", string> = {
	blocking: "❌ Mudanças necessárias",
	attention: "⚠️ Aprovado com ressalvas",
	clean: "✅ Aprovado",
};

/** Corta o texto em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function plural(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** Resumo de negócio: modelo de intenção; sem ele, contexto da PR/branch. */
function businessSection(input: ReviewResumeInput): string[] {
	const lines = ["## Resumo de negócio", ""];
	const business = input.business;

	if (
		business &&
		(business.intent || business.flows.length > 0 || business.invariants.length > 0)
	) {
		if (business.intent) lines.push(business.intent, "");
		else if (input.context?.objective) lines.push(input.context.objective, "");
		const rendered = renderBusinessLines(business).filter(
			(line) => !line.startsWith("**Intenção:**"),
		);
		if (rendered.length > 0) lines.push(...rendered, "");
		if (input.context?.motivation) {
			lines.push(`**Por quê:** ${truncate(input.context.motivation, 480)}`, "");
		}
		return lines;
	}

	const context = input.context;
	const hasContext =
		context?.available === true &&
		Boolean(
			context.objective ||
				context.motivation ||
				(context.changeSummary && context.changeSummary.length > 0),
		);

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
		for (const item of context.changeSummary.slice(0, 6)) {
			lines.push(`- ${truncate(item, 240)}`);
		}
		lines.push("");
	}
	return lines;
}

/** Pontos técnicos estruturais (módulos, contratos, impacto) — não achados. */
function technicalSection(summary: TechnicalSummary | null | undefined): string[] {
	const lines = ["## Pontos técnicos", ""];
	if (!summary || (!summary.overview && summary.highlights.length === 0)) {
		lines.push("Sem mudanças estruturais detectadas nesta revisão.", "");
		return lines;
	}
	if (summary.overview) lines.push(summary.overview, "");
	for (const highlight of summary.highlights) {
		lines.push(`- **${highlight.area}** — ${truncate(highlight.detail, 300)}`);
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
 * nasce do contexto já disponível e dos pontos técnicos persistidos.
 */
export function renderReviewResume(input: ReviewResumeInput): string {
	const blockers = input.findings.filter((f) => f.severity === "blocking").length;
	const attention = input.findings.filter((f) => f.severity === "attention").length;
	const status =
		blockers > 0
			? STATUS_BY_SEVERITY.blocking
			: attention > 0
				? STATUS_BY_SEVERITY.attention
				: STATUS_BY_SEVERITY.clean;

	const lines = [
		`# Resumo da revisão — ${input.branch}`,
		"",
		`**Data:** ${input.date ?? systemClock().slice(0, 10)} · **Status:** ${status}`,
		"",
		...businessSection(input),
		...technicalSection(input.technical),
	];

	return clamp(`${lines.join("\n").trimEnd()}\n`, RESUME_MAX_CHARS);
}
