/**
 * Comparação A/B de duas revisões da mesma branch (funções puras).
 *
 * O objetivo é responder "o que mudou entre as duas execuções?" sem tentar
 * eleger um vencedor: conta achados por severidade, cobertura, tempo e tokens,
 * e lista o que apareceu/sumiu entre A e B.
 */

import { SEVERITY_ORDER, type Severity } from "./types";

/** Finding normalizado para a comparação. */
export type ComparisonFinding = {
	fingerprint: string;
	rule: string;
	severity: Severity;
	file: string;
	line?: number;
	message: string;
	watchdogs: readonly string[];
};

/** Snapshot de uma execução (uma das pontas do A/B). */
export type ReviewSnapshot = {
	/** Rótulo exibido (`A`, `B` ou a variante). */
	label: string;
	slug: string;
	branch: string;
	variant?: string;
	headSha?: string;
	model?: string;
	/** Achados presentes no último relatório. */
	findings: readonly ComparisonFinding[];
	bySeverity: Record<Severity, number>;
	coverage: { watchdogs: number; files: number; overflow: number };
	/** Duração do ciclo (`startedAt` → `reviewedAt`), quando medida. */
	durationMs?: number;
	/** Duração do prepare (`prepare-report.json`). */
	prepareMs?: number;
	/** Duração do harness maki (`hunt-report.json`). */
	huntMs?: number;
	tokens?: number;
	costUsd?: number;
};

/** Resultado da comparação. */
export type ReviewComparison = {
	branch: string;
	headSha?: string;
	a: ReviewSnapshot;
	b: ReviewSnapshot;
	onlyA: readonly ComparisonFinding[];
	onlyB: readonly ComparisonFinding[];
	common: readonly { a: ComparisonFinding; b: ComparisonFinding }[];
	severityChanged: readonly { a: ComparisonFinding; b: ComparisonFinding }[];
};

/** Conta os achados por severidade. */
export function countBySeverity(
	findings: readonly ComparisonFinding[],
): Record<Severity, number> {
	const counts: Record<Severity, number> = {
		blocking: 0,
		attention: 0,
		suggestion: 0,
		nit: 0,
	};
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

/** Compara dois snapshots (ordem estável por severidade e caminho). */
export function buildComparison(a: ReviewSnapshot, b: ReviewSnapshot): ReviewComparison {
	const aByKey = new Map(a.findings.map((finding) => [finding.fingerprint, finding]));
	const bByKey = new Map(b.findings.map((finding) => [finding.fingerprint, finding]));
	const onlyA = a.findings.filter((finding) => !bByKey.has(finding.fingerprint));
	const onlyB = b.findings.filter((finding) => !aByKey.has(finding.fingerprint));
	const common: { a: ComparisonFinding; b: ComparisonFinding }[] = [];
	const severityChanged: { a: ComparisonFinding; b: ComparisonFinding }[] = [];

	for (const finding of a.findings) {
		const other = bByKey.get(finding.fingerprint);
		if (!other) continue;
		common.push({ a: finding, b: other });
		if (finding.severity !== other.severity) {
			severityChanged.push({ a: finding, b: other });
		}
	}

	const sortFindings = (items: ComparisonFinding[]): ComparisonFinding[] =>
		[...items].sort(
			(x, y) =>
				SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity) ||
				x.file.localeCompare(y.file) ||
				(x.line ?? 0) - (y.line ?? 0) ||
				x.rule.localeCompare(y.rule),
		);

	return {
		branch: a.branch,
		headSha: a.headSha ?? b.headSha,
		a,
		b,
		onlyA: sortFindings(onlyA),
		onlyB: sortFindings(onlyB),
		common,
		severityChanged: severityChanged.sort(
			(x, y) =>
				SEVERITY_ORDER.indexOf(x.a.severity) -
					SEVERITY_ORDER.indexOf(y.a.severity) ||
				x.a.file.localeCompare(y.a.file),
		),
	};
}

/** Duração legível (`820ms`, `12.3s`, `2m05s`). */
function formatMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "—";
	const safe = Math.max(0, Math.round(ms));
	if (safe < 1_000) return `${safe}ms`;
	const seconds = safe / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function formatDelta(
	a: number | undefined,
	b: number | undefined,
	format: (value: number) => string,
): string {
	if (a === undefined || b === undefined) return "—";
	const delta = b - a;
	return `${delta > 0 ? "+" : ""}${format(delta)}`;
}

/** Linha da tabela de métricas. */
function metricRow(label: string, a: string, b: string, delta = "—"): string {
	return `| ${label} | ${a} | ${b} | ${delta} |`;
}

/** Lista compacta de um conjunto de achados. */
function findingList(title: string, findings: readonly ComparisonFinding[]): string[] {
	if (findings.length === 0) return [`## ${title}`, "", "_Nenhum._", ""];
	const shown = findings.slice(0, 20);
	const lines = [`## ${title} (${findings.length})`, ""];
	for (const finding of shown) {
		const line = finding.line !== undefined ? `:${finding.line}` : "";
		lines.push(
			`- **${finding.severity}** · \`${finding.file}${line}\` — ${finding.message}`,
		);
	}
	if (findings.length > shown.length) {
		lines.push(`- … +${findings.length - shown.length} achado(s)`);
	}
	lines.push("");
	return lines;
}

/** Renderiza a comparação em Markdown (artefato e stdout). */
export function renderComparison(comparison: ReviewComparison): string {
	const { a, b } = comparison;
	const severityDelta = SEVERITY_ORDER.map((severity) =>
		metricRow(
			severity,
			String(a.bySeverity[severity]),
			String(b.bySeverity[severity]),
			formatDelta(a.bySeverity[severity], b.bySeverity[severity], (value) =>
				String(value),
			),
		),
	);
	const totalA = a.findings.length;
	const totalB = b.findings.length;
	const lines = [
		`# Comparação A/B — \`${comparison.branch}\``,
		"",
		`**A:** ${labelOf(a)} · **B:** ${labelOf(b)}`,
		...(comparison.headSha
			? [`**Commit:** \`${comparison.headSha.slice(0, 7)}\``]
			: []),
		"",
		"> Compara o que apareceu/sumiu entre as execuções. Não é veredito: confirme",
		"> cada achado novo no código antes de considerá-lo ganho ou perda.",
		"",
		"## Métricas",
		"",
		`| Métrica | A | B | Δ |`,
		`| --- | --- | --- | --- |`,
		metricRow(
			"Findings (presentes)",
			String(totalA),
			String(totalB),
			formatDelta(totalA, totalB, (value) => String(value)),
		),
		...severityDelta,
		metricRow(
			"Cobertura (arquivos)",
			String(a.coverage.files),
			String(b.coverage.files),
		),
		metricRow(
			"Watchdogs",
			String(a.coverage.watchdogs),
			String(b.coverage.watchdogs),
		),
		metricRow("Duração total", formatMs(a.durationMs), formatMs(b.durationMs)),
		metricRow("Prepare", formatMs(a.prepareMs), formatMs(b.prepareMs)),
		metricRow("Harness", formatMs(a.huntMs), formatMs(b.huntMs)),
		metricRow(
			"Tokens",
			a.tokens !== undefined ? String(a.tokens) : "—",
			b.tokens !== undefined ? String(b.tokens) : "—",
		),
		metricRow(
			"Custo",
			a.costUsd !== undefined ? `$${a.costUsd.toFixed(4)}` : "—",
			b.costUsd !== undefined ? `$${b.costUsd.toFixed(4)}` : "—",
		),
		"",
		...findingList("Só em B (novos)", comparison.onlyB),
		...findingList("Só em A (não apareceram em B)", comparison.onlyA),
	];
	if (comparison.severityChanged.length > 0) {
		lines.push(`## Severidade mudou (${comparison.severityChanged.length})`, "");
		for (const item of comparison.severityChanged.slice(0, 20)) {
			lines.push(
				`- \`${item.a.file}\` — ${item.a.rule}: **${item.a.severity} → ${item.b.severity}**`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** JSON estável da comparação (artefato para automação). */
export function comparisonToJson(comparison: ReviewComparison): string {
	return `${JSON.stringify(comparison, null, 2)}\n`;
}

function labelOf(snapshot: ReviewSnapshot): string {
	const variant = snapshot.variant ? ` (variante \`${snapshot.variant}\`)` : "";
	return `\`${snapshot.slug}\`${variant} · ${snapshot.findings.length} finding(s)`;
}
