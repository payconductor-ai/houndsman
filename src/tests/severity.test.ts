/** Severidade determinística: ancoragem por regra e por classe de impacto. */

import { describe, expect, test } from "bun:test";
import type { Finding, WatchdogReport } from "../core/report-builder";
import {
	anchorReports,
	IMPACT_CLASSES,
	normalizeRuleText,
	resolveDeclaredSeverity,
	SEVERITY_BY_IMPACT,
	severityAnchoringMessages,
} from "../core/severity";
import type { Rule } from "../core/types";
import { FAKE_WATCHDOG_DEFINITIONS } from "./fixtures/fake-project";

/** União das regras do projeto fake (o mesmo que o finalize monta). */
function declaredRules(): Rule[] {
	return Object.values(FAKE_WATCHDOG_DEFINITIONS).flatMap((def) => [...def.rules]);
}

function finding(partial: Partial<Finding> & { rule: string }): Finding {
	return {
		rule: partial.rule,
		severity: partial.severity ?? "attention",
		file: partial.file ?? "src/alpha/a.ts",
		line: partial.line,
		message: partial.message ?? "msg",
		action: partial.action ?? "ação",
		basis: partial.basis,
		impactClass: partial.impactClass,
		evidence: partial.evidence,
		scenario: partial.scenario,
	};
}

function report(findings: Finding[], watchdogId = "alpha"): WatchdogReport {
	return {
		watchdogId,
		reviewedFiles: ["src/alpha/a.ts"],
		skipped: [],
		findings,
	};
}

describe("normalizeRuleText", () => {
	test("remove markdown, emoji, bullet e prefixo de severidade do brief", () => {
		expect(
			normalizeRuleText(
				"- ❌ **blocking** — Promover: todo fluxo tem caminho completo.",
			),
		).toBe("promover: todo fluxo tem caminho completo");
	});

	test("colapsa espaços e ignora caixa", () => {
		expect(normalizeRuleText("Evitar   CONSOLE.log")).toBe("evitar console.log");
	});
});

describe("resolveDeclaredSeverity", () => {
	test("casa pelo texto exato normalizado", () => {
		expect(
			resolveDeclaredSeverity("Nunca usar `any`.", declaredRules())?.severity,
		).toBe("blocking");
	});

	test("casa quando o watchdog cita um trecho da regra", () => {
		const declared = resolveDeclaredSeverity(
			"Vale para todo handler: validar entrada do usuário",
			declaredRules(),
		);
		expect(declared?.severity).toBe("attention");
	});

	test("texto sem casamento devolve null", () => {
		expect(
			resolveDeclaredSeverity(
				"Regra inventada que não está no brief.",
				declaredRules(),
			),
		).toBeNull();
	});

	test("mesmo texto em dois watchdogs fica com a severidade mais grave", () => {
		const rules: Rule[] = [
			{ severity: "attention", text: "Promover: todo fluxo tem caminho completo." },
			{ severity: "blocking", text: "Promover: todo fluxo tem caminho completo." },
		];
		expect(
			resolveDeclaredSeverity("Promover: todo fluxo tem caminho completo.", rules)
				?.severity,
		).toBe("blocking");
	});
});

describe("impactClass", () => {
	test("toda classe tem severidade mapeada", () => {
		expect(IMPACT_CLASSES).toHaveLength(4);
		expect(SEVERITY_BY_IMPACT["flow-break"]).toBe("blocking");
		expect(SEVERITY_BY_IMPACT["contract-drift"]).toBe("attention");
		expect(SEVERITY_BY_IMPACT.degradation).toBe("suggestion");
		expect(SEVERITY_BY_IMPACT.cosmetic).toBe("nit");
	});
});

describe("anchorReports", () => {
	test("finding de regra assume a severidade declarada e registra a divergência", () => {
		const anchoring = anchorReports(
			[report([finding({ rule: "Nunca usar `any`.", severity: "attention" })])],
			declaredRules(),
		);
		expect(anchoring.reports[0]?.findings[0]?.severity).toBe("blocking");
		expect(anchoring.anchored).toBe(1);
		expect(anchoring.diverged).toHaveLength(1);
		expect(anchoring.diverged[0]).toMatchObject({
			emitted: "attention",
			resolved: "blocking",
			source: "rule",
			watchdogId: "alpha",
		});
	});

	test("finding de regra sem casamento mantém o valor e entra em unmatched", () => {
		const anchoring = anchorReports(
			[
				report([
					finding({
						rule: "Regra parafraseada fora do brief",
						severity: "nit",
					}),
				]),
			],
			declaredRules(),
		);
		expect(anchoring.reports[0]?.findings[0]?.severity).toBe("nit");
		expect(anchoring.unmatched).toBe(1);
		expect(anchoring.diverged).toHaveLength(0);
	});

	test("emergente com flow-break e prova vira blocking", () => {
		const anchoring = anchorReports(
			[
				report([
					finding({
						rule: "Lógica: renovação não fecha o fluxo",
						severity: "suggestion",
						basis: "logic",
						impactClass: "flow-break",
						scenario: "renovação de assinatura",
						evidence: "await renew(data)",
					}),
				]),
			],
			declaredRules(),
		);
		expect(anchoring.reports[0]?.findings[0]?.severity).toBe("blocking");
		expect(anchoring.classified).toBe(1);
		expect(anchoring.diverged[0]).toMatchObject({
			source: "impact",
			resolved: "blocking",
		});
	});

	test("flow-break sem cenário+evidência cai para attention", () => {
		const anchoring = anchorReports(
			[
				report([
					finding({
						rule: "Domínio: estado sem tratamento",
						severity: "suggestion",
						basis: "domain",
						impactClass: "flow-break",
					}),
				]),
			],
			declaredRules(),
		);
		expect(anchoring.reports[0]?.findings[0]?.severity).toBe("attention");
		expect(anchoring.diverged[0]?.resolved).toBe("attention");
	});

	test("emergente sem impactClass mantém o valor emitido", () => {
		const anchoring = anchorReports(
			[
				report([
					finding({
						rule: "Domínio: algo",
						severity: "nit",
						basis: "domain",
						impactClass: "desconhecida",
					}),
				]),
			],
			declaredRules(),
		);
		expect(anchoring.reports[0]?.findings[0]?.severity).toBe("nit");
		expect(anchoring.classified).toBe(0);
		expect(anchoring.unmatched).toBe(0);
		expect(anchoring.diverged).toHaveLength(0);
	});
});

describe("severityAnchoringMessages", () => {
	test("resume contagens, exemplos e a falta de casamento", () => {
		const anchoring = anchorReports(
			[
				report([
					finding({ rule: "Nunca usar `any`.", severity: "attention" }),
					finding({
						rule: "Lógica: fluxo não fecha",
						severity: "nit",
						basis: "logic",
						impactClass: "flow-break",
						scenario: "gatilho",
						evidence: "trecho",
					}),
					finding({ rule: "Regra inventada", severity: "nit" }),
				]),
			],
			declaredRules(),
		);
		const messages = severityAnchoringMessages(anchoring);
		expect(messages[0]).toContain("1 pela regra");
		expect(messages[0]).toContain("1 pelo impacto");
		expect(messages[0]).toContain("2 divergência(s)");
		expect(messages.some((message) => message.includes("sem casamento"))).toBe(true);
	});

	test("silencia quando nada é resolvido", () => {
		const anchoring = anchorReports(
			[report([finding({ rule: "Lógica: x", basis: "logic" })])],
			declaredRules(),
		);
		expect(severityAnchoringMessages(anchoring)).toEqual([]);
	});
});
