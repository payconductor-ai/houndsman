/**
 * Relatórios JSON dos watchdogs: tipos, validação, normalização e dedupe.
 *
 * Entrypoint: `cli/review.ts` (via `core/orchestrator.ts`). A renderização do
 * resumo final vive em `core/renderers/resume-renderer.ts`.
 *
 * Schema dos watchdogs: asset `OUTPUT-FORMAT.md` (embarcado em `src/skill/`).
 */

import { anchorContentKey, buildAnchor } from "./finding-anchor";
import {
	isDeclaredRule,
	isDistinctAnchor,
	isNearDuplicate,
	normalizeFindingPath,
	occurrenceKey,
	outweighs,
} from "./finding-identity";
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
	 * Classe de impacto de um finding emergente (`flow-break`/`contract-drift`/
	 * `degradation`/`cosmetic`). Define a severidade fora de regra — ver
	 * `core/severity.ts`; o valor emitido em `severity` é ignorado quando presente.
	 */
	impactClass?: string;
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
	/**
	 * Ocorrências do mesmo achado colapsadas neste item (>1 = repetição).
	 * Vira `count` na triagem; a `line` guarda só a primeira ocorrência.
	 */
	occurrences?: number;
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
			f.basis === "domain") &&
		(f.impactClass === undefined || typeof f.impactClass === "string")
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
	// Caminho canônico na ingestão: `./src/x.ts` e `src/x.ts` são o mesmo arquivo
	// (dedupe, escopo do diff e âncora dependem disso).
	const normalized: Finding = {
		...finding,
		file: normalizeFindingPath(finding.file),
		basis,
		confidence,
	};
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

	const paths = (value: unknown): string[] =>
		Array.isArray(value)
			? value
					.filter((item): item is string => typeof item === "string")
					.map(normalizeFindingPath)
			: [];

	return {
		watchdogId: obj.watchdogId,
		reviewedFiles: paths(obj.reviewedFiles),
		skipped: paths(obj.skipped),
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

/** Duplicatas colapsadas por camada (diagnóstico do `--finalize`). */
export type DedupeStats = {
	/** Mesmo arquivo + mesma regra (a linha é cache, não identidade). */
	collapsedByRule: number;
	/** Mesmo trecho ancorado descrito por dois achados emergentes. */
	collapsedByAnchor: number;
};

/** Opções do dedupe. */
export type DedupeOptions = {
	/**
	 * Leitor do arquivo alterado. Sem ele roda só a camada (arquivo, regra) —
	 * a camada por âncora precisa do conteúdo para localizar o trecho.
	 */
	readFile?: (file: string) => string | null;
};

/** Resultado do dedupe, com as contagens de colapso. */
export type DedupeResult = {
	findings: MergedFinding[];
	stats: DedupeStats;
};

/**
 * Une dois achados do MESMO problema.
 *
 * O representante é o mais forte (`outweighs`: regra declarada > domínio >
 * lógica, depois severidade). A regra declarada define texto, ação e severidade
 * — ela é a fonte da política do projeto. Watchdogs e ocorrências sempre se
 * somam; campos complementares nunca se perdem.
 */
function mergeDuplicate(existing: MergedFinding, incoming: MergedFinding): MergedFinding {
	const watchdogs = [...existing.watchdogs];
	for (const watchdog of incoming.watchdogs) {
		if (!watchdogs.includes(watchdog)) watchdogs.push(watchdog);
	}
	const preferred = outweighs(incoming, existing) ? incoming : existing;
	const other = preferred === incoming ? existing : incoming;
	const confidence = Math.max(preferred.confidence ?? 0, other.confidence ?? 0);
	return {
		...other,
		...preferred,
		watchdogs,
		occurrences: (existing.occurrences ?? 1) + (incoming.occurrences ?? 1),
		line: preferred.line ?? other.line,
		evidence: preferred.evidence ?? other.evidence,
		scenario: preferred.scenario ?? other.scenario,
		impact: preferred.impact ?? other.impact,
		impactClass: preferred.impactClass ?? other.impactClass,
		foundAtSha: preferred.foundAtSha ?? other.foundAtSha,
		confidence: confidence > 0 ? confidence : undefined,
	};
}

/** Chave do trecho ancorado (`arquivo|âncora`), ou null sem âncora distinta. */
function anchoredKey(
	finding: MergedFinding,
	readFile: (file: string) => string | null,
): string | null {
	const file = normalizeFindingPath(finding.file);
	const content = readFile(file);
	if (!content) return null;
	const anchor = buildAnchor(content, finding.line, finding.evidence);
	if (!anchor || !isDistinctAnchor(anchor.snippet)) return null;
	return `${file}|${anchorContentKey(anchor)}`;
}

/** Ordena por severidade, arquivo e linha (a ordem de exibição). */
function sortFindings(findings: MergedFinding[]): MergedFinding[] {
	return findings.sort((a, b) => {
		const bySeverity = severityRank(a.severity) - severityRank(b.severity);
		if (bySeverity !== 0) return bySeverity;
		if (a.file !== b.file) return a.file.localeCompare(b.file);
		return (a.line ?? 0) - (b.line ?? 0);
	});
}

/**
 * Camada 3 do relatório — grupos de achados que descrevem o mesmo defeito com
 * texto diferente.
 *
 * **Não mescla**: o mesmo trecho pode abrigar assuntos distintos (um achado de
 * testabilidade e um bug concreto ancorados na mesma linha colapsam sob
 * qualquer limiar de similaridade textual). O `--finalize` usa isto para
 * avisar o revisor; a decisão de consolidar é humana.
 */
export function nearbyDuplicateGroups(
	findings: readonly MergedFinding[],
): MergedFinding[][] {
	const groups: MergedFinding[][] = [];
	for (const finding of findings) {
		const group = groups.find((members) =>
			members.some((member) => isNearDuplicate(member, finding)),
		);
		if (group) group.push(finding);
		else groups.push([finding]);
	}
	return groups.filter((group) => group.length > 1);
}

/**
 * Deduplica achados em duas camadas determinísticas, mesclando atribuição de
 * watchdogs.
 *
 * 1. **(arquivo, regra)** — a linha não entra na chave: o mesmo anti-padrão
 *    apontado em N trechos do mesmo arquivo é UM achado com N ocorrências.
 * 2. **trecho ancorado** — mesmo código, ambos os achados emergentes. Dois
 *    achados de regra no mesmo trecho são regras diferentes, não duplicata.
 *
 * Paráfrases entre watchdogs (regex diferentes para o mesmo defeito) NÃO são
 * mescladas: o mesmo trecho pode ter assuntos distintos. Ver
 * `nearbyDuplicateGroups`.
 */
export function dedupeFindingsWithStats(
	reports: readonly WatchdogReport[],
	options: DedupeOptions = {},
): DedupeResult {
	const stats: DedupeStats = { collapsedByRule: 0, collapsedByAnchor: 0 };

	const byRule = new Map<string, MergedFinding>();
	for (const report of reports) {
		for (const finding of report.findings) {
			const key = occurrenceKey(finding);
			const current: MergedFinding = { ...finding, watchdogs: [report.watchdogId] };
			const existing = byRule.get(key);
			if (!existing) {
				byRule.set(key, current);
				continue;
			}
			byRule.set(key, mergeDuplicate(existing, current));
			stats.collapsedByRule++;
		}
	}

	const readFile = options.readFile;
	if (!readFile) return { findings: sortFindings([...byRule.values()]), stats };

	const grouped: MergedFinding[] = [];
	const byAnchor = new Map<string, number>();
	for (const finding of byRule.values()) {
		const key = anchoredKey(finding, readFile);
		const index = key === null ? undefined : byAnchor.get(key);
		if (key === null || index === undefined) {
			if (key !== null) byAnchor.set(key, grouped.length);
			grouped.push(finding);
			continue;
		}
		const existing = grouped[index];
		if (!existing) {
			grouped.push(finding);
			continue;
		}
		// Dois achados com regra declarada no mesmo trecho: regras diferentes.
		if (isDeclaredRule(existing.rule) || isDeclaredRule(finding.rule)) {
			grouped.push(finding);
			continue;
		}
		grouped[index] = mergeDuplicate(existing, finding);
		stats.collapsedByAnchor++;
	}

	return { findings: sortFindings(grouped), stats };
}

/** Deduplica achados e devolve só a lista (sem as contagens). */
export function dedupeFindings(
	reports: readonly WatchdogReport[],
	options: DedupeOptions = {},
): MergedFinding[] {
	return dedupeFindingsWithStats(reports, options).findings;
}
