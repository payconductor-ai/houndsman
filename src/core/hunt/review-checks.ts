/**
 * Checklist de revisão do harness local (`houndsman hunt`).
 *
 * O agente headless tende a "ler o diff e concluir" — cobertura alta no papel e
 * profundidade baixa. Aqui ficam as funções puras que transformam o modelo de
 * intenção (fluxos + invariantes) em itens verificáveis, comparam o que o
 * watchdog declarou e mesclam duas passadas do mesmo brief.
 *
 * Nada disto vira contrato do `--finalize`: é diagnóstico do harness, gravado
 * em `hunt-report.json`.
 */

import { GENERAL_WATCHDOG_ID } from "../builtins";
import type { BusinessSummary } from "../business-summary";
import type { Finding } from "../report-builder";
import { severityRank } from "../types";

/** Resultado declarado de uma verificação. */
export type CheckVerdict = "ok" | "gap" | "n/a";

/** Verificação de um item do modelo de intenção. */
export type ReviewCheck = {
	/** Texto do fluxo/invariante (copiado do brief). */
	item: string;
	verdict: CheckVerdict;
	/** Onde foi verificado (`arquivo:linha` ou `arquivo · símbolo`). */
	at?: string;
};

/** Cobertura declarada por um watchdog. */
export type CheckCoverage = {
	expected: number;
	verified: number;
	missing: number;
	gaps: number;
};

/** Normaliza caminho de arquivo (`.\a\b` → `a/b`). */
export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** Normaliza um item para comparação (sem acento, caixa e pontuação). */
function normalizeItem(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Arquivos do domínio declarados pelo brief.
 *
 * Lê a seção `## Arquivos do seu domínio` (lista em code-span); `[]` quando o
 * brief não a traz.
 */
export function briefDomainFiles(brief: string): string[] {
	const lines = brief.split(/\r?\n/);
	const files: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (/^##\s+Arquivos do seu dom/i.test(line)) {
			inside = true;
			continue;
		}
		if (inside) {
			if (/^##\s+/.test(line)) break;
			const match = line.match(/^-\s+`([^`]+)`/);
			if (match) files.push(normalizePath(match[1]));
		}
	}
	return files;
}

/** Normaliza a lista de verificações devolvida pelo JSON do watchdog. */
export function parseReviewChecks(raw: unknown): ReviewCheck[] {
	if (typeof raw !== "object" || raw === null) return [];
	const entries = (raw as Record<string, unknown>).checks;
	if (!Array.isArray(entries)) return [];
	const checks: ReviewCheck[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			const item = entry.trim();
			if (item) checks.push({ item, verdict: "n/a" });
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const item =
			typeof record.item === "string"
				? record.item.trim()
				: typeof record.check === "string"
					? record.check.trim()
					: "";
		if (!item) continue;
		const verdict = verdictOf(record.verdict);
		const at = typeof record.at === "string" ? record.at.trim() : undefined;
		checks.push({ item, verdict, at });
	}
	return checks;
}

/** Veredito tolerante a variações de grafia do modelo. */
function verdictOf(value: unknown): CheckVerdict {
	if (typeof value !== "string") return "n/a";
	const text = value.trim().toLowerCase();
	if (text === "ok" || text === "pass" || text === "passed") return "ok";
	if (text === "gap" || text === "fail" || text === "failed" || text === "missing") {
		return "gap";
	}
	return "n/a";
}

/**
 * Itens que o watchdog deveria verificar neste brief.
 *
 * Fluxos são recortados pelos arquivos do domínio (o brief já faz o mesmo
 * recorte); invariantes valem para todos — são o contrato de negócio da PR.
 */
export function expectedReviewItems(
	brief: string,
	business: BusinessSummary | null | undefined,
	watchdogId: string,
): string[] {
	if (!business) return [];
	const isGeneral = watchdogId === GENERAL_WATCHDOG_ID;
	const own = new Set(briefDomainFiles(brief));
	const flows = business.flows
		.filter(
			(flow) =>
				isGeneral ||
				!flow.files ||
				flow.files.length === 0 ||
				flow.files.some((file) => own.has(normalizePath(file))),
		)
		.map((flow) => flow.name);
	const items = [...flows, ...business.invariants];
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const item of items) {
		const key = normalizeItem(item);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(item);
	}
	return unique;
}

/** `true` quando a verificação declarada corresponde ao item esperado. */
export function matchesItem(check: ReviewCheck, expected: string): boolean {
	const left = normalizeItem(check.item);
	const right = normalizeItem(expected);
	if (!left || !right) return false;
	if (left === right) return true;
	// O modelo às vezes resume o item; aceita contenção para não gerar passada
	// extra só por diferença de redação.
	const shortest = Math.min(left.length, right.length);
	return shortest >= 16 && (left.includes(right) || right.includes(left));
}

/** Itens esperados sem verificação declarada. */
export function missingReviewItems(
	expected: readonly string[],
	checks: readonly ReviewCheck[],
): string[] {
	return expected.filter((item) => !checks.some((check) => matchesItem(check, item)));
}

/** Resumo da cobertura do checklist. */
export function summarizeChecks(
	expected: readonly string[],
	checks: readonly ReviewCheck[],
): CheckCoverage {
	const missing = missingReviewItems(expected, checks).length;
	const verified = expected.length - missing;
	const gaps = checks.filter((check) => check.verdict === "gap").length;
	return { expected: expected.length, verified, missing, gaps };
}

/** Mescla dois checklists (o mais recente vence no mesmo item). */
export function mergeChecks(
	first: readonly ReviewCheck[],
	second: readonly ReviewCheck[],
): ReviewCheck[] {
	const merged = [...first];
	for (const check of second) {
		const index = merged.findIndex((item) => matchesItem(item, check.item));
		if (index >= 0) merged[index] = check;
		else merged.push(check);
	}
	return merged;
}

/** Chave de dedupe de findings entre passadas do mesmo watchdog. */
function findingKey(finding: Finding): string {
	return `${normalizePath(finding.file)}|${finding.line ?? 0}|${normalizeItem(finding.rule)}`;
}

/** Une findings de duas passadas, preservando o de maior severidade. */
export function mergeFindings(
	first: readonly Finding[],
	second: readonly Finding[],
): Finding[] {
	const merged = [...first];
	const index = new Map(
		merged.map((finding, position) => [findingKey(finding), position]),
	);
	for (const finding of second) {
		const key = findingKey(finding);
		const position = index.get(key);
		if (position === undefined) {
			index.set(key, merged.length);
			merged.push(finding);
			continue;
		}
		const current = merged[position];
		if (severityRank(finding.severity) < severityRank(current.severity)) {
			merged[position] = finding;
		}
	}
	return merged;
}

/** Pontuação de riqueza do modelo de intenção (fluxos e contratos pesam mais). */
export function businessScore(summary: BusinessSummary | null | undefined): number {
	if (!summary) return 0;
	return (
		(summary.intent ? 1 : 0) +
		summary.flows.length * 3 +
		summary.invariants.length +
		summary.contracts.length * 2 +
		summary.states.length
	);
}

/** Decisão do gate de substituição do modelo de intenção. */
export type BusinessDecision = {
	/** Modelo que deve permanecer no staging. */
	summary: BusinessSummary | null;
	accepted: boolean;
};

/**
 * Decide se o modelo devolvido pelo revisor de fluxo substitui o existente.
 *
 * O `general` reconstrói a intenção sem enxergar o JSON original inteiro; sem
 * este gate ele já sobrescreveu um modelo rico da IA por um resumo de 4
 * invariantes e 0 fluxos, e o relatório final perdeu os fluxos.
 */
export function chooseBusinessSummary(
	existing: BusinessSummary | null | undefined,
	incoming: BusinessSummary | null | undefined,
): BusinessDecision {
	if (!incoming) return { summary: existing ?? null, accepted: false };
	if (!existing || existing.source === "deterministic") {
		return { summary: incoming, accepted: true };
	}
	const accepted = businessScore(incoming) > businessScore(existing);
	return { summary: accepted ? incoming : existing, accepted };
}
