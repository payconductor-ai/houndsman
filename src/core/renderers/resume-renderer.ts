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

/** Teto de caracteres do artefato (inclui cabeçalho e quebras de linha). */
export const RESUME_MAX_CHARS = 2500;

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

/** Corta o texto em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function plural(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
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
		...technicalSection(input.findings, nameOf),
	];

	return clamp(`${lines.join("\n").trimEnd()}\n`, RESUME_MAX_CHARS);
}
