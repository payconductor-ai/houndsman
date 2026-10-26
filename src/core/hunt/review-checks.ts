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
import type { Finding, WatchdogReport } from "../report-builder";
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

/** Regra declarada no brief (numerada para o checklist). */
export type ReviewRule = {
	/** Número exibido no brief (identidade compacta no JSON). */
	id: number;
	severity: string;
	text: string;
};

/** Veredito de uma regra declarada. */
export type RuleCheck = {
	id: number;
	verdict: CheckVerdict;
	/** Onde a regra foi (ou não) honrada. */
	at?: string;
};

/** Cobertura declarada por um watchdog. */
export type CheckCoverage = {
	expected: number;
	/**
	 * Itens **com prova**: `ok`/`gap` com `at` resolvido para arquivo/linha
	 * existentes. `n/a` não conta — é ausência de verificação, não cobertura.
	 */
	verified: number;
	/** Itens sem veredito declarado. */
	missing: number;
	/** Itens declarados `n/a` (não se aplicam ao domínio). */
	notApplicable: number;
	/** Vereditos `gap` (violação declarada). */
	gaps: number;
};

/**
 * Resolve se um `at` aponta para código existente.
 *
 * O runner injeta a checagem real (arquivo existe + linha dentro do arquivo);
 * testes e análises puras usam o default permissivo.
 */
export type AtResolver = (file: string, line?: number) => boolean;

/** Localização declarada (`arquivo:linha`, `arquivo:12-20` ou `arquivo · símbolo`). */
export type CheckLocation = { file: string; line?: number };

/** Extrai arquivo/linha de um `at` declarado pelo modelo. */
export function parseLocation(at: string | undefined): CheckLocation | null {
	const value = at?.trim();
	if (!value) return null;

	// `arquivo · símbolo` — sem linha, mas com arquivo explícito.
	const [head] = value.split("\u00b7");
	const trimmed = head.trim();
	const match = trimmed.match(/^(.+?):(\d+)(?:\s*-\s*\d+)?$/);
	if (match) return { file: normalizePath(match[1]), line: Number(match[2]) };

	// Sem `:linha`, aceita apenas o que parece caminho de arquivo.
	if (/[\\/]/.test(trimmed) && /\.[A-Za-z0-9]{1,5}$/.test(trimmed)) {
		return { file: normalizePath(trimmed) };
	}
	return null;
}

/** `true` quando a verificação tem prova (veredito com localização válida). */
export function isCheckVerified(
	check: { verdict: CheckVerdict; at?: string },
	resolve: AtResolver,
): boolean {
	if (check.verdict === "n/a") return false;
	const location = parseLocation(check.at);
	if (!location) return false;
	return resolve(location.file, location.line);
}

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
 * Regras declaradas no brief (`## Regras (por severidade)`), já numeradas.
 *
 * O número é a identidade compacta usada no checklist: o watchdog devolve
 * `{ id, verdict }` por regra, sem repetir o texto (que pode ter 200 chars).
 */
export function briefRules(brief: string): ReviewRule[] {
	const lines = brief.split(/\r?\n/);
	const rules: ReviewRule[] = [];
	let inside = false;
	for (const line of lines) {
		if (/^##\s+Regras\b/i.test(line)) {
			inside = true;
			continue;
		}
		if (inside) {
			if (/^##\s+/.test(line)) break;
			const match = line.match(
				/^-\s+(\d+)\.\s+.*?\*\*(blocking|attention|suggestion|nit)\*\*\s*[—–-]\s*(.+)$/,
			);
			if (!match) continue;
			rules.push({
				id: Number.parseInt(match[1], 10),
				severity: match[2],
				text: match[3].trim(),
			});
		}
	}
	return rules;
}

/** Normaliza os vereditos das regras devolvidos pelo JSON do watchdog. */
export function parseRuleChecks(raw: unknown): RuleCheck[] {
	if (typeof raw !== "object" || raw === null) return [];
	const entries = (raw as Record<string, unknown>).rules;
	if (!Array.isArray(entries)) return [];
	const checks: RuleCheck[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			const match = entry.match(/^\s*(\d+)\s*[:=-]?\s*(ok|gap|n\/a|pass|fail)?/i);
			if (!match) continue;
			checks.push({
				id: Number.parseInt(match[1], 10),
				verdict: verdictOf(match[2]),
			});
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const rawId = record.id ?? record.rule ?? record.number;
		const id =
			typeof rawId === "number"
				? rawId
				: Number.parseInt(String(rawId ?? "").replace(/\D/g, ""), 10);
		if (!Number.isFinite(id) || id <= 0) continue;
		const at = typeof record.at === "string" ? record.at.trim() : undefined;
		checks.push({ id, verdict: verdictOf(record.verdict), at });
	}
	return checks;
}

/** Regras declaradas sem verificação. */
export function missingRuleChecks(
	rules: readonly ReviewRule[],
	checks: readonly RuleCheck[],
): number[] {
	const seen = new Set(checks.map((check) => check.id));
	return rules.filter((rule) => !seen.has(rule.id)).map((rule) => rule.id);
}

/** Resumo da cobertura das regras declaradas. */
export function summarizeRuleChecks(
	rules: readonly ReviewRule[],
	checks: readonly RuleCheck[],
	resolve: AtResolver = TRUST_LOCATIONS,
): CheckCoverage {
	const byRule = rules.map((rule) => checks.find((check) => check.id === rule.id));
	const declared = byRule.filter((check): check is RuleCheck => check !== undefined);
	return {
		expected: rules.length,
		verified: declared.filter((check) => isCheckVerified(check, resolve)).length,
		missing: rules.length - declared.length,
		notApplicable: declared.filter((check) => check.verdict === "n/a").length,
		gaps: declared.filter((check) => check.verdict === "gap").length,
	};
}

/** Mescla dois checklists de regras (o mais recente vence no mesmo id). */
export function mergeRuleChecks(
	first: readonly RuleCheck[],
	second: readonly RuleCheck[],
): RuleCheck[] {
	const merged = new Map(first.map((check) => [check.id, check]));
	for (const check of second) merged.set(check.id, check);
	return [...merged.values()].sort((a, b) => a.id - b.id);
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

/** Resolver default: aceita qualquer localização (análises puras/testes). */
const TRUST_LOCATIONS: AtResolver = () => true;

/** Resumo da cobertura do checklist. */
export function summarizeChecks(
	expected: readonly string[],
	checks: readonly ReviewCheck[],
	resolve: AtResolver = TRUST_LOCATIONS,
): CheckCoverage {
	const byItem = expected.map((item) =>
		checks.find((check) => matchesItem(check, item)),
	);
	const declared = byItem.filter((check): check is ReviewCheck => check !== undefined);
	const notApplicable = declared.filter((check) => check.verdict === "n/a").length;
	return {
		expected: expected.length,
		verified: declared.filter((check) => isCheckVerified(check, resolve)).length,
		missing: expected.length - declared.length,
		notApplicable,
		gaps: declared.filter((check) => check.verdict === "gap").length,
	};
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

/** Primeira frase do texto (para inferir a identidade de um finding emergente). */
function firstSentence(message: string, max = 160): string {
	const text = message.trim().replace(/\s+/g, " ");
	if (text.length === 0) return "achado sem descrição";
	const cut = text.search(/[.!?](\s|$)/);
	const sentence = cut > 0 ? text.slice(0, cut) : text;
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * Garante `rule` não vazio (identidade de exibição/triagem do finding).
 *
 * O modelo às vezes descreve o achado só em `message` e deixa `rule: ""`.
 * Para emergente, o prefixo `Lógica:`/`Domínio:` preserva a semântica do
 * `basis` e permite a derivação de severidade por `impactClass`.
 */
export function withInferredRule(report: WatchdogReport): WatchdogReport {
	const findings = report.findings.map((finding) => {
		if (finding.rule.trim().length > 0) return finding;
		const prefix = (finding.basis ?? "logic") === "domain" ? "Domínio: " : "Lógica: ";
		return { ...finding, rule: `${prefix}${firstSentence(finding.message)}` };
	});
	return { ...report, findings };
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
