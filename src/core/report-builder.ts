/**
 * Relatórios JSON dos watchdogs: tipos, validação, normalização e dedupe.
 *
 * Entrypoint: `cli/review.ts` (via `core/orchestrator.ts`). A renderização do
 * resumo final vive em `core/renderers/resume-renderer.ts`.
 *
 * Schema dos watchdogs: asset `OUTPUT-FORMAT.md` (embarcado em `src/skill/`).
 */

import { SEVERITY_ORDER, type Severity, severityRank } from "./types";

/** Origem do finding: regra explícita, consistência lógica ou domínio. */
export type FindingBasis = "rule" | "logic" | "domain";

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
	/** Gatilho concreto que expõe o gap (obrigatório para `blocking` fora de regra). */
	scenario?: string;
	/** Consequência observável do gap. */
	impact?: string;
	/** Confiança do revisor (0–1). */
	confidence?: number;
	/** Origem do achado; inferida pelo prefixo `Lógica:`/`Domínio:` quando ausente. */
	basis?: FindingBasis;
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
 * Limites do resumo da PR: o contexto abre o relatório e o resumo final, mas
 * não pode inflar os briefs — a injeção nos briefs é recortada em `brief.ts`.
 */
const CONTEXT_LIMITS = {
	objective: 400,
	motivation: 480,
	changeSummaryItem: 240,
	changeSummaryItems: 6,
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

/** Normaliza o rótulo de uma variante A/B (`baseline` → `baseline`). */
export function sanitizeVariant(variant: string): string {
	return variant
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 32);
}

/** Hash curto e estável (FNV-1a) para desambiguar slugs de variantes. */
function shortHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(6, "0").slice(0, 6);
}

/**
 * Slug da run (diretório do backend de arquivos e URL da UI).
 *
 * Run principal: slug da branch. Variante A/B: `branch--variante-<hash>` — o
 * hash garante unicidade mesmo quando dois rótulos sanitizam para o mesmo texto.
 */
export function reviewSlug(branch: string, variant?: string): string {
	const base = sanitizeBranch(branch);
	const label = variant?.trim() ? sanitizeVariant(variant) : "";
	if (!label) return base;
	return `${base}--${label}-${shortHash(`${branch}\u0000${variant?.trim() ?? ""}`)}`;
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
		(f.line === undefined || typeof f.line === "number") &&
		(f.scenario === undefined || typeof f.scenario === "string") &&
		(f.impact === undefined || typeof f.impact === "string") &&
		(f.confidence === undefined || typeof f.confidence === "number") &&
		(f.basis === undefined ||
			f.basis === "rule" ||
			f.basis === "logic" ||
			f.basis === "domain")
	);
}

/** Infere a origem do finding pelo prefixo reservado da regra. */
export function inferBasis(rule: string): FindingBasis {
	const text = rule.trim().toLowerCase();
	if (text.startsWith("lógica:") || text.startsWith("logica:")) return "logic";
	if (text.startsWith("domínio:") || text.startsWith("dominio:")) return "domain";
	return "rule";
}

/**
 * Normaliza um finding e aplica a política de severidade: fora de regra,
 * `blocking` exige `scenario` + `evidence`; sem os dois, rebaixa para
 * `attention`. A regra explícita mantém a severidade declarada pelo watchdog.
 */
export function normalizeFinding(
	finding: Finding,
	onWarn: (message: string) => void = () => {},
): Finding {
	const basis = finding.basis ?? inferBasis(finding.rule);
	const confidence =
		finding.confidence === undefined
			? undefined
			: Math.min(1, Math.max(0, finding.confidence));
	const normalized: Finding = { ...finding, basis, confidence };
	if (basis !== "rule" && normalized.severity === "blocking") {
		const proven = Boolean(
			normalized.scenario?.trim() && normalized.evidence?.trim(),
		);
		if (!proven) {
			normalized.severity = "attention";
			onWarn(
				`[report-builder] ${finding.file}: finding ${basis} sem cenário+evidência rebaixado para attention.`,
			);
		}
	}
	return normalized;
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

	const findings: Finding[] = [];
	for (const item of obj.findings) {
		if (!isFinding(item)) {
			onError(`[report-builder] ${source}: finding inválido ignorado`);
			continue;
		}
		findings.push(normalizeFinding(item, onError));
	}

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
				// Cenário/impacto/confiança nunca se perdem no merge.
				existing.scenario = existing.scenario ?? finding.scenario;
				existing.impact = existing.impact ?? finding.impact;
				if (finding.confidence !== undefined) {
					existing.confidence = Math.max(
						existing.confidence ?? 0,
						finding.confidence,
					);
				}
				existing.basis = existing.basis ?? finding.basis;
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
