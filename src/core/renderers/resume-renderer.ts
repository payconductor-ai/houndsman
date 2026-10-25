/**
 * Resumo final da revisão (`review-resume.md`).
 *
 * Artefato somente-leitura para humanos: não entra em briefs, não é lido pelos
 * watchdogs e não participa de nenhuma etapa seguinte. Une o contexto de
 * negócio da PR aos pontos técnicos estruturais da revisão, com limite de
 * `RESUME_MAX_CHARS`.
 */

import { type BusinessSummary, renderBusinessLines } from "../business-summary";
import type { JevCandidate } from "../jev";
import type { ContextSummary, MergedFinding } from "../report-builder";
import { systemClock } from "../services/clock";
import type { TechnicalSummary } from "../technical-summary";

/**
 * Teto de caracteres do artefato (inclui cabeçalho e quebras de linha).
 *
 * As tabelas e a conclusão têm orçamento reservado — só o texto narrativo
 * (negócio/técnico) é cortado quando o resumo cresce.
 */
export const RESUME_MAX_CHARS = 8000;

/** Fração do orçamento narrativo destinada ao resumo de negócio. */
const BUSINESS_SHARE = 0.6;

/** Piso do orçamento narrativo mesmo em PRs com muitos domínios. */
const MIN_NARRATIVE_CHARS = 1200;

/** Dados de classificação usados no resumo. */
export type ResumeClassification = {
	files: Record<string, { status: string }>;
	watchdogs: Record<string, string[]>;
};

/** Cobertura de um domínio (watchdog) na revisão. */
export type ResumeDomain = {
	id: string;
	name: string;
	findings: number;
	reviewedFiles: number;
	expectedFiles: number;
	/** Arquivos do escopo declarados em `skipped` (não revisados por decisão). */
	skippedFiles?: number;
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
	/** Cobertura por domínio (arquivos revisados × esperados). */
	domains?: readonly ResumeDomain[];
	/** Candidatos da pré-análise que nenhum watchdog confirmou. */
	candidates?: readonly JevCandidate[];
	/** Aviso opcional no topo (ex.: revisão incremental). */
	note?: string;
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
		while (rendered[0] === "") rendered.shift();
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

/** Conclusão com os totais por severidade. */
function conclusionSection(findings: readonly MergedFinding[]): string[] {
	const counts = {
		blocking: findings.filter((f) => f.severity === "blocking").length,
		attention: findings.filter((f) => f.severity === "attention").length,
		suggestion: findings.filter((f) => f.severity === "suggestion").length,
		nit: findings.filter((f) => f.severity === "nit").length,
	};
	return [
		"## Conclusão",
		"",
		`**Resumo:** ${counts.blocking} bloqueantes · ${counts.attention} atenção · ${counts.suggestion} sugestões · ${counts.nit} nits.`,
		"",
	];
}

/** Cobertura por domínio: revisados, declarados fora do recorte e lacunas. */
function coverageSection(domains: readonly ResumeDomain[]): string[] {
	if (domains.length === 0) return [];
	const lines = [
		"## Cobertura por domínio",
		"",
		"| Domínio | Achados | Revisados | Fora do recorte | Faltam |",
		"|---|---|---|---|---|",
	];
	for (const domain of domains) {
		const skipped = domain.skippedFiles ?? 0;
		const missing = Math.max(
			0,
			domain.expectedFiles - domain.reviewedFiles - skipped,
		);
		lines.push(
			`| ${domain.name} | ${domain.findings} | ${domain.reviewedFiles}/${domain.expectedFiles} | ${skipped > 0 ? skipped : "—"} | ${missing > 0 ? missing : "—"} |`,
		);
	}
	lines.push(
		"",
		"> `Faltam` = arquivos do escopo sem revisão e sem declaração em `skipped`.",
		"",
	);
	return lines;
}

/** Candidatos da pré-análise que nenhum watchdog confirmou (não bloqueiam). */
function candidatesSection(
	candidates: readonly JevCandidate[],
	findings: readonly MergedFinding[],
): string[] {
	if (candidates.length === 0) return [];
	const confirmed = new Set(findings.map((f) => `${f.file}|${f.rule}`));
	const pending = candidates.filter((c) => !confirmed.has(`${c.file}|${c.rule}`));
	if (pending.length === 0) return [];
	const lines = [
		`## Candidatos não verificados (${pending.length})`,
		"",
		"> Indícios da pré-análise que nenhum watchdog confirmou. Não bloqueiam.",
		"",
	];
	for (const candidate of pending.slice(0, 8)) {
		lines.push(
			`- \`${candidate.file}\` · ${candidate.severity} · ${truncate(candidate.rule, 160)}`,
		);
	}
	if (pending.length > 8) lines.push(`- … +${pending.length - 8}`);
	lines.push("");
	return lines;
}

/**
 * Renderiza o resumo final. Determinístico e sem chamadas externas: o texto
 * nasce do contexto já disponível, do modelo de intenção, dos pontos técnicos
 * e da cobertura por domínio. `review-resume.md` é o único artefato humano.
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

	const header = [
		`# Resumo da revisão — ${input.branch}`,
		"",
		`**Data:** ${input.date ?? systemClock().slice(0, 10)} · **Status:** ${status}`,
		...(input.note?.trim() ? ["", input.note.trim()] : []),
	].join("\n");

	const coverage = coverageSection(input.domains ?? []).join("\n");
	const candidates = candidatesSection(input.candidates ?? [], input.findings).join(
		"\n",
	);
	const conclusion = conclusionSection(input.findings).join("\n");

	// Tabelas e conclusão primeiro: o que sobra é o orçamento do texto narrativo.
	const reserved = [header, coverage, candidates, conclusion]
		.filter((part) => part.length > 0)
		.join("\n\n").length;
	const budget = Math.max(MIN_NARRATIVE_CHARS, RESUME_MAX_CHARS - reserved);
	const businessMax = Math.floor(budget * BUSINESS_SHARE);
	const business = clamp(businessSection(input).join("\n"), businessMax);
	const technical = clamp(
		technicalSection(input.technical).join("\n"),
		budget - businessMax,
	);

	const body = [header, business, technical, coverage, candidates, conclusion]
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
	return `${body}\n`;
}
