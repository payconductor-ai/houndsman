/**
 * Severidade determinística (biblioteca) — a regra manda, não a opinião do watchdog.
 *
 * Finding de regra (`basis: "rule"`) usa a severidade declarada em `Rule.severity`;
 * finding emergente (`Lógica:`/`Domínio:`) usa a tabela fixa de `impactClass`. O valor
 * emitido só prevalece quando não há como resolver (paráfrase sem casamento, relatório
 * legado sem `impactClass`) — fail-open. Toda divergência é contabilizada para o
 * finalize avisar e para o `compare` provar a estabilidade entre runs.
 */

import { type Finding, inferBasis, type WatchdogReport } from "./report-builder";
import { type Rule, type Severity, severityRank } from "./types";

/** Classe de impacto de um finding emergente — define a severidade fora de regra. */
export type ImpactClass = "flow-break" | "contract-drift" | "degradation" | "cosmetic";

/** Classes válidas, da mais para a menos grave. */
export const IMPACT_CLASSES: readonly ImpactClass[] = [
	"flow-break",
	"contract-drift",
	"degradation",
	"cosmetic",
];

/** Tabela fixa `impactClass` → severidade. */
export const SEVERITY_BY_IMPACT: Record<ImpactClass, Severity> = {
	"flow-break": "blocking",
	"contract-drift": "attention",
	degradation: "suggestion",
	cosmetic: "nit",
};

const IMPACT_SET = new Set<string>(IMPACT_CLASSES);

/** Tamanho mínimo para casar uma regra com o trecho citado pelo watchdog. */
const MIN_FRAGMENT_CHARS = 24;

/** `true` quando `value` é uma classe de impacto conhecida. */
export function isImpactClass(value: unknown): value is ImpactClass {
	return typeof value === "string" && IMPACT_SET.has(value);
}

/**
 * Texto canônico da regra para casar `findings[].rule` com `rules[].text`.
 *
 * O brief imprime `- ❌ **blocking** — Promover: …`; o watchdog às vezes copia a
 * linha inteira, às vezes só o trecho. A normalização remove markdown, emoji,
 * bullet e o prefixo de severidade antes de comparar.
 */
export function normalizeRuleText(text: string): string {
	return text
		.normalize("NFC")
		.replace(/[`*_]/g, "")
		.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/^[-•]\s*/u, "")
		.replace(/^(blocking|attention|suggestion|nit)\s*[—–-]\s*/u, "")
		.replace(/[.:;]+$/u, "")
		.trim();
}

/** Regra declarada correspondente a um texto de finding. */
export type DeclaredSeverity = { rule: Rule; severity: Severity };

/**
 * Resolve a regra declarada que corresponde ao texto reportado.
 *
 * Exato primeiro; depois contenção (o modelo citou a regra inteira ou um trecho
 * com pelo menos `MIN_FRAGMENT_CHARS`). Empate entre watchdogs fica com a regra
 * mais grave — determinístico e coerente com o dedupe.
 */
export function resolveDeclaredSeverity(
	ruleText: string,
	rules: readonly Rule[],
): DeclaredSeverity | null {
	const needle = normalizeRuleText(ruleText);
	if (!needle) return null;

	const candidates = rules.map((rule) => ({
		rule,
		text: normalizeRuleText(rule.text),
	}));
	const exact = candidates.filter((item) => item.text === needle);
	const matches =
		exact.length > 0
			? exact
			: candidates.filter((item) => isFragment(needle, item.text));
	if (matches.length === 0) return null;

	let best = matches[0].rule;
	for (const item of matches) {
		if (severityRank(item.rule.severity) < severityRank(best.severity)) {
			best = item.rule;
		}
	}
	return { rule: best, severity: best.severity };
}

/** Contenção nos dois sentidos, exigindo fragmento longo o bastante. */
function isFragment(a: string, b: string): boolean {
	if (a.length < MIN_FRAGMENT_CHARS || b.length < MIN_FRAGMENT_CHARS) return false;
	return a.includes(b) || b.includes(a);
}

/** De onde veio a severidade aplicada. */
export type SeveritySource = "rule" | "impact";

/** Divergência entre o valor emitido e o resolvido (para aviso no finalize). */
export type SeverityDivergence = {
	watchdogId: string;
	file: string;
	rule: string;
	emitted: Severity;
	resolved: Severity;
	source: SeveritySource;
};

/** Resultado da ancoragem sobre os relatórios de uma run. */
export type SeverityAnchoring = {
	reports: WatchdogReport[];
	/** Findings de regra cujo texto casou com uma regra declarada. */
	anchored: number;
	/** Findings emergentes com `impactClass` válido. */
	classified: number;
	/** Findings de regra sem casamento (severidade emitida mantida). */
	unmatched: number;
	diverged: SeverityDivergence[];
};

type Resolution = { severity: Severity; source: SeveritySource };

/** Severidade declarada pelo motor (null = manter a emitida). */
function resolveSeverity(finding: Finding, rules: readonly Rule[]): Resolution | null {
	if ((finding.basis ?? inferBasis(finding.rule)) !== "rule") {
		const impact = finding.impactClass;
		if (!isImpactClass(impact)) return null;
		return { severity: SEVERITY_BY_IMPACT[impact], source: "impact" };
	}
	const declared = resolveDeclaredSeverity(finding.rule, rules);
	return declared ? { severity: declared.severity, source: "rule" } : null;
}

/**
 * Gate de prova: fora de regra, `blocking` exige gatilho + evidência.
 *
 * `normalizeFinding` já aplica isso na leitura do relatório; a checagem aqui
 * cobre chamadas com findings construídos em memória (harness/testes).
 */
function provenSeverity(finding: Finding, resolution: Resolution): Severity {
	if (resolution.source !== "impact" || resolution.severity !== "blocking") {
		return resolution.severity;
	}
	const proven = Boolean(finding.scenario?.trim() && finding.evidence?.trim());
	return proven ? "blocking" : "attention";
}

/**
 * Ancora a severidade de todos os relatórios (função pura — devolve novos objetos).
 * `rules` é a união das regras de todos os watchdogs ativos (inclui o piso do `general`).
 */
export function anchorReports(
	reports: readonly WatchdogReport[],
	rules: readonly Rule[],
): SeverityAnchoring {
	const anchoring: SeverityAnchoring = {
		reports: [],
		anchored: 0,
		classified: 0,
		unmatched: 0,
		diverged: [],
	};

	for (const report of reports) {
		const findings = report.findings.map((finding) => {
			const resolution = resolveSeverity(finding, rules);
			if (!resolution) {
				if ((finding.basis ?? inferBasis(finding.rule)) === "rule") {
					anchoring.unmatched++;
				}
				return finding;
			}

			if (resolution.source === "rule") anchoring.anchored++;
			else anchoring.classified++;

			const severity = provenSeverity(finding, resolution);
			if (severity === finding.severity) return finding;

			anchoring.diverged.push({
				watchdogId: report.watchdogId,
				file: finding.file,
				rule: finding.rule,
				emitted: finding.severity,
				resolved: severity,
				source: resolution.source,
			});
			return { ...finding, severity };
		});
		anchoring.reports.push({ ...report, findings });
	}

	return anchoring;
}

/** Texto curto do finding nas mensagens do finalize. */
function describe(divergence: SeverityDivergence, max = 72): string {
	const text =
		divergence.rule.length <= max
			? divergence.rule
			: `${divergence.rule.slice(0, max - 1).trimEnd()}…`;
	return `· ${divergence.watchdogId} \`${divergence.file}\` — ${divergence.emitted} → ${divergence.resolved} (${divergence.source === "rule" ? "regra" : "impacto"}): ${text}`;
}

/**
 * Mensagens de resumo da ancoragem (vazias quando nada foi resolvido nem corrigido).
 * `limit` controla quantos exemplos de divergência aparecem.
 */
export function severityAnchoringMessages(
	anchoring: SeverityAnchoring,
	limit = 3,
): string[] {
	const messages: string[] = [];
	if (anchoring.anchored > 0 || anchoring.classified > 0) {
		const parts = [
			anchoring.anchored > 0 ? `${anchoring.anchored} pela regra` : "",
			anchoring.classified > 0 ? `${anchoring.classified} pelo impacto` : "",
		].filter(Boolean);
		const corrected =
			anchoring.diverged.length > 0
				? ` — ${anchoring.diverged.length} divergência(s) corrigida(s).`
				: ".";
		messages.push(`Severidade: ${parts.join(", ")}${corrected}`);
	}
	for (const divergence of anchoring.diverged.slice(0, limit)) {
		messages.push(describe(divergence));
	}
	if (anchoring.unmatched > 0) {
		messages.push(
			`Severidade: ${anchoring.unmatched} finding(s) de regra sem casamento com as regras declaradas (valor emitido mantido).`,
		);
	}
	return messages;
}
