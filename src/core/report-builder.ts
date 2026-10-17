/**
 * Consolidação dos relatórios JSON dos watchdogs em um markdown (biblioteca).
 *
 * Entrypoint: `cli/review.ts` (via `core/orchestrator.ts`). Deduplica achados
 * por (file, line, rule), agrupa por severidade e renderiza a tabela de cobertura.
 *
 * Schema dos watchdogs: asset `OUTPUT-FORMAT.md` (embarcado em `src/skill/`).
 */

import type { JevCandidate } from "./jev";
import { systemClock } from "./services/clock";
import { SEVERITY_EMOJI, SEVERITY_ORDER, type Severity, severityRank } from "./types";

/** Resolve o nome legível de um watchdog (default: identidade). */
export type WatchdogNameResolver = (watchdogId: string) => string;

const identityName: WatchdogNameResolver = (id) => id;

export type Finding = {
	/** Id curto do finding (preenchido no `--finalize`; usado pela triagem). */
	id?: string;
	rule: string;
	severity: Severity;
	file: string;
	line?: number;
	message: string;
	action: string;
	evidence?: string;
	/**
	 * Commit em que o achado foi observado (interno). Preenchido nos carry-over
	 * do review incremental — preserva a referência para a verificação (verify).
	 */
	foundAtSha?: string;
};

export type WatchdogReport = {
	watchdogId: string;
	reviewedFiles: string[];
	skipped: string[];
	findings: Finding[];
};

/** Achado deduplicado, com todos os watchdogs que o apontaram. */
export type MergedFinding = Finding & {
	watchdogs: string[];
};

/** Resumo do contexto da PR (objetivo/motivação/resumo das alterações), gravado pelo subagente. */
export type ContextSummary = {
	available: boolean;
	source?: {
		number?: number;
		title?: string;
		url?: string;
		base?: string;
		head?: string;
	};
	objective?: string;
	motivation?: string;
	changeSummary?: string[];
};

const VALID_SEVERITIES = new Set<string>(SEVERITY_ORDER);

/**
 * Limites do resumo da PR: mantém o relatório e os briefs enxutos — evita
 * confundir o watchdog humano e estourar o contexto da IA watchdog.
 */
const CONTEXT_LIMITS = {
	objective: 200,
	motivation: 240,
	changeSummaryItem: 160,
	changeSummaryItems: 4,
} as const;

/** Corta `value` em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Helpers exportados (testáveis)
// ---------------------------------------------------------------------------

/** `feature/add-webhook` → `feature-add-webhook`. */
export function sanitizeBranch(branch: string): string {
	return branch
		.trim()
		.replace(/[/\\]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function isFinding(value: unknown): value is Finding {
	if (typeof value !== "object" || value === null) return false;
	const f = value as Record<string, unknown>;
	return (
		typeof f.rule === "string" &&
		typeof f.severity === "string" &&
		VALID_SEVERITIES.has(f.severity) &&
		typeof f.file === "string" &&
		typeof f.message === "string" &&
		typeof f.action === "string" &&
		(f.line === undefined || typeof f.line === "number")
	);
}

/** Valida e normaliza um relatório. Retorna null se inválido. */
export function parseWatchdogReport(
	raw: unknown,
	source: string,
	onError: (message: string) => void = () => {},
): WatchdogReport | null {
	if (typeof raw !== "object" || raw === null) {
		onError(`[report-builder] ${source}: não é um objeto JSON`);
		return null;
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.watchdogId !== "string") {
		onError(`[report-builder] ${source}: campo 'watchdogId' ausente`);
		return null;
	}
	if (!Array.isArray(obj.findings)) {
		onError(`[report-builder] ${source}: campo 'findings' ausente`);
		return null;
	}

	const findings = obj.findings.filter((f) => {
		if (!isFinding(f)) {
			onError(`[report-builder] ${source}: finding inválido ignorado`);
			return false;
		}
		return true;
	});

	return {
		watchdogId: obj.watchdogId,
		reviewedFiles: Array.isArray(obj.reviewedFiles)
			? (obj.reviewedFiles as string[])
			: [],
		skipped: Array.isArray(obj.skipped) ? (obj.skipped as string[]) : [],
		findings,
	};
}

/**
 * Valida/normaliza o `context-summary.json` do subagente de contexto.
 * Retorna null se indisponível ou sem conteúdo útil — a seção é omitida.
 * Aplica limites de tamanho: o resumo precisa ser curto para não confundir o
 * watchdog humano nem estourar o contexto da IA watchdog (briefs + relatório).
 */
export function parseContextSummary(raw: unknown): ContextSummary | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.available !== true) return null;

	const text = (value: unknown, max = Number.POSITIVE_INFINITY): string | undefined => {
		const trimmed = typeof value === "string" ? value.trim() : "";
		return trimmed.length > 0 ? truncate(trimmed, max) : undefined;
	};
	const objective = text(obj.objective, CONTEXT_LIMITS.objective);
	const motivation = text(obj.motivation, CONTEXT_LIMITS.motivation);
	const changeSummary = (Array.isArray(obj.changeSummary) ? obj.changeSummary : [])
		.map((item) => text(item, CONTEXT_LIMITS.changeSummaryItem))
		.filter((item): item is string => item !== undefined)
		.slice(0, CONTEXT_LIMITS.changeSummaryItems);

	if (!objective && !motivation && changeSummary.length === 0) return null;

	const src = (obj.source ?? {}) as Record<string, unknown>;
	const source = {
		number: typeof src.number === "number" ? src.number : undefined,
		title: text(src.title),
		url: text(src.url),
		base: text(src.base),
		head: text(src.head),
	};

	return { available: true, source, objective, motivation, changeSummary };
}

/** Deduplica achados por (file, line, rule), mesclando atribuição de watchdogs. */
export function dedupeFindings(reports: WatchdogReport[]): MergedFinding[] {
	const map = new Map<string, MergedFinding>();
	for (const report of reports) {
		for (const finding of report.findings) {
			const key = `${finding.file}|${finding.line ?? ""}|${finding.rule}`;
			const existing = map.get(key);
			if (existing) {
				if (!existing.watchdogs.includes(report.watchdogId)) {
					existing.watchdogs.push(report.watchdogId);
				}
				// Mantém a versão de maior severidade (severidade + detalhes)
				if (severityRank(finding.severity) < severityRank(existing.severity)) {
					existing.severity = finding.severity;
					existing.message = finding.message;
					existing.action = finding.action;
					existing.evidence = finding.evidence ?? existing.evidence;
				}
				continue;
			}
			map.set(key, { ...finding, watchdogs: [report.watchdogId] });
		}
	}
	return [...map.values()].sort((a, b) => {
		const bySeverity = severityRank(a.severity) - severityRank(b.severity);
		if (bySeverity !== 0) return bySeverity;
		if (a.file !== b.file) return a.file.localeCompare(b.file);
		return (a.line ?? 0) - (b.line ?? 0);
	});
}

function watchdogName(nameOf: WatchdogNameResolver, id: string): string {
	return nameOf(id);
}

function renderFinding(finding: MergedFinding, nameOf: WatchdogNameResolver): string[] {
	const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	const watchdogs = finding.watchdogs.map((r) => watchdogName(nameOf, r)).join(", ");
	const id = finding.id ? ` · \`${finding.id}\`` : "";
	const lines = [
		`- **${finding.rule}** — \`${location}\` · _${watchdogs}_${id}`,
		`  ${finding.message}`,
		`  **Ação:** ${finding.action}`,
	];
	if (finding.evidence) {
		lines.push(`  **Evidência:** \`${finding.evidence}\``);
	}
	lines.push("");
	return lines;
}

function renderCoverage(
	reports: WatchdogReport[],
	coverage: { classified?: Record<string, string[]> },
	nameOf: WatchdogNameResolver,
): string[] {
	const lines = [
		"## Cobertura",
		"",
		"| Watchdog | Arquivos revisados | Findings |",
		"|---|---|---|",
	];
	for (const report of reports) {
		const expected = coverage.classified?.[report.watchdogId];
		const reviewed = new Set(report.reviewedFiles);
		const pending = expected ? expected.filter((f) => !reviewed.has(f)) : [];
		const reviewedLabel =
			expected && pending.length > 0
				? `${report.reviewedFiles.length}/${expected.length} (faltam ${pending.length})`
				: `${report.reviewedFiles.length}`;
		lines.push(
			`| ${watchdogName(nameOf, report.watchdogId)} | ${reviewedLabel} | ${report.findings.length} |`,
		);
	}
	lines.push("");
	return lines;
}

/** Candidatos Jev não confirmados por nenhum watchdog — revisão manual, não bloqueiam. */
function renderUnconfirmedCandidates(
	candidates: JevCandidate[],
	merged: MergedFinding[],
): string[] {
	const confirmed = new Set(merged.map((f) => `${f.file}|${f.rule}`));
	const pending = candidates.filter((c) => !confirmed.has(`${c.file}|${c.rule}`));
	if (pending.length === 0) return [];
	const lines = [
		"## 🔎 Candidatos não verificados (Jev)",
		"",
		"> Indícios automáticos que nenhum watchdog confirmou. Revise manualmente — não bloqueiam.",
		"",
	];
	for (const c of pending) {
		lines.push(
			`- \`${c.file}\` · **${c.severity}** · confiança ${c.confidence.toFixed(2)} · _${c.watchdogId}_`,
			`  ${c.rule}`,
			"",
		);
	}
	return lines;
}

function renderConclusion(counts: Record<Severity, number>): string[] {
	const status =
		counts.blocking > 0
			? "❌ Mudanças Necessárias"
			: counts.attention > 0
				? "⚠️ Aprovado com Ressalvas"
				: "✅ Aprovado";
	return [
		"## Conclusão",
		"",
		`**Status:** ${status}`,
		`**Resumo:** ${counts.blocking} violações bloqueantes, ${counts.attention} pontos de atenção, ${counts.suggestion} sugestões e ${counts.nit} nits.`,
	];
}

/**
 * Agrupa os achados por arquivo (navegabilidade em PRs grandes) e renderiza cada
 * bloco. O `merged` já vem ordenado por severidade/arquivo/linha.
 */
function renderFindingsByFile(
	findings: readonly MergedFinding[],
	nameOf: WatchdogNameResolver,
): string[] {
	const byFile = new Map<string, MergedFinding[]>();
	for (const finding of findings) {
		const list = byFile.get(finding.file);
		if (list) list.push(finding);
		else byFile.set(finding.file, [finding]);
	}

	const lines: string[] = [];
	for (const [file, items] of byFile) {
		lines.push(`### \`${file}\``, "");
		for (const item of items) lines.push(...renderFinding(item, nameOf));
	}
	return lines;
}

/** Seções por severidade (❌ > ⚠️ > 💡 > 🔎), com achados agrupados por arquivo. */
function renderFindingsSections(
	merged: readonly MergedFinding[],
	nameOf: WatchdogNameResolver,
): string[] {
	const lines: string[] = [];
	for (const severity of SEVERITY_ORDER) {
		const items = merged.filter((f) => f.severity === severity);
		if (items.length === 0) continue;
		lines.push(`## ${SEVERITY_EMOJI[severity]} ${severity}`, "");
		lines.push(...renderFindingsByFile(items, nameOf));
	}
	return lines;
}

/** Relatório de domínio gravado à parte (um por watchdog com achados). */
export type DomainReport = {
	id: string;
	name: string;
	/** Nome do arquivo do relatório (relativo ao diretório de artefatos). */
	file: string;
	findings: number;
	reviewedFiles: number;
	expectedFiles: number;
};

/** Índice dos relatórios por domínio (seção do `review.md` consolidado). */
function renderDomainIndex(domains: readonly DomainReport[]): string[] {
	if (domains.length === 0) return [];
	const lines = [
		"## Relatórios por domínio",
		"",
		"| Watchdog | Achados | Revisados | Relatório |",
		"|---|---|---|---|",
	];
	for (const domain of domains) {
		lines.push(
			`| ${domain.name} | ${domain.findings} | ${domain.reviewedFiles}/${domain.expectedFiles} | [\`${domain.file}\`](${domain.file}) |`,
		);
	}
	lines.push("");
	return lines;
}

/**
 * Relatório isolado de um watchdog — mantém o `review.md` enxuto em PRs grandes.
 */
export function renderDomainReport(
	branch: string,
	report: WatchdogReport,
	merged: MergedFinding[],
	expectedFiles: number,
	context?: ContextSummary | null,
	nameOf: WatchdogNameResolver = identityName,
): string {
	const now = systemClock().slice(0, 10);
	const name = watchdogName(nameOf, report.watchdogId);
	const lines: string[] = [
		`# Review — ${name} (\`${report.watchdogId}\`) — ${branch}`,
		"",
		`**Data:** ${now}`,
		`**Arquivos revisados:** ${report.reviewedFiles.length}/${expectedFiles}`,
		`**Achados:** ${merged.length}`,
		"",
	];

	if (context?.available) lines.push(...renderContext(context));

	lines.push(...renderFindingsSections(merged, nameOf));
	if (merged.length === 0) lines.push("Nenhum achado. ✅", "");

	if (report.skipped.length > 0) {
		lines.push(
			"## Não revisados",
			"",
			...report.skipped.map((item) => `- \`${item}\``),
			"",
		);
	}

	return lines.join("\n");
}

/** Seção de contexto da PR (Objetivo / Motivação / Resumo das alterações). */
function renderContext(context: ContextSummary): string[] {
	const lines = ["## Contexto da PR", ""];
	const src = context.source;

	const ref = [src?.number ? `#${src.number}` : "", src?.title ?? ""]
		.filter(Boolean)
		.join(" ");
	if (ref) lines.push(`**PR:** ${ref}${src?.url ? ` — ${src.url}` : ""}`);
	if (src?.head && src?.base)
		lines.push(`**Branch:** \`${src.head}\` → \`${src.base}\``);
	if (context.objective) lines.push(`**Objetivo:** ${context.objective}`);
	if (context.motivation) lines.push(`**Motivação:** ${context.motivation}`);
	if (context.changeSummary && context.changeSummary.length > 0) {
		lines.push("", "**Resumo das alterações:**", "");
		for (const item of context.changeSummary) lines.push(`- ${item}`);
	}
	lines.push("");
	return lines;
}

export function renderReport(
	branch: string,
	reports: WatchdogReport[],
	merged: MergedFinding[],
	coverage: { classified?: Record<string, string[]> },
	context?: ContextSummary | null,
	candidates?: JevCandidate[],
	nameOf: WatchdogNameResolver = identityName,
	domains: readonly DomainReport[] = [],
): string {
	const now = systemClock().slice(0, 10);
	const counts = {
		blocking: merged.filter((f) => f.severity === "blocking").length,
		attention: merged.filter((f) => f.severity === "attention").length,
		suggestion: merged.filter((f) => f.severity === "suggestion").length,
		nit: merged.filter((f) => f.severity === "nit").length,
	};

	const lines: string[] = [
		`# PR Review — ${branch}`,
		"",
		`**Data:** ${now}`,
		`**Watchdogs ativos:** ${reports.map((r) => r.watchdogId).join(", ") || "—"}`,
		`**Achados:** ${counts.blocking} bloqueantes · ${counts.attention} atenção · ${counts.suggestion} sugestões · ${counts.nit} nits`,
		"",
	];

	if (context) lines.push(...renderContext(context));

	lines.push(...renderFindingsSections(merged, nameOf));

	if (merged.length === 0) {
		lines.push("Nenhum achado. ✅", "");
	}

	if (candidates && candidates.length > 0) {
		lines.push(...renderUnconfirmedCandidates(candidates, merged));
	}

	lines.push(...renderDomainIndex(domains));
	lines.push(...renderCoverage(reports, coverage, nameOf));
	lines.push(...renderConclusion(counts));

	return lines.join("\n");
}
