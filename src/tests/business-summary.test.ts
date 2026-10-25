/**
 * Modelo de intenção (`business-summary.json`) e política de severidade dos
 * findings de lógica/domínio.
 */

import { describe, expect, test } from "bun:test";
import type { AstAnalysis } from "../core/ast/types";
import { defaultRenderBrief } from "../core/brief";
import { GENERAL_WATCHDOG_ID, generalWatchdog } from "../core/builtins";
import {
	buildBusinessBrief,
	buildBusinessSummary,
	parseBusinessSummary,
} from "../core/business-summary";
import { normalizeFinding } from "../core/report-builder";
import { findWatchdog } from "../core/watchdog-registry";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

const facts: AstAnalysis["facts"] = {
	language: "typescript",
	symbols: [],
	imports: [],
	exports: [],
	decorators: [],
	hasSyntaxErrors: false,
};

const delta = {
	addedSymbols: [
		{
			name: "Contrato",
			kind: "interface" as const,
			exported: true,
			startLine: 1,
			endLine: 3,
		},
		{
			name: "executar",
			kind: "function" as const,
			exported: true,
			startLine: 5,
			endLine: 9,
		},
	],
	removedSymbols: [],
	modifiedSymbols: [],
	changedSignatures: [],
	addedImports: [],
	removedImports: [],
	changedExports: [],
};

const classification = {
	files: {
		"src/alpha/a.ts": { status: "modified" as const },
		"src/beta/b.ts": { status: "modified" as const },
		"src/alpha/old.ts": { status: "deleted" as const },
	},
	churn: {
		"src/alpha/a.ts": { additions: 10, deletions: 2 },
		"src/beta/b.ts": { additions: 1, deletions: 0 },
	},
	watchdogs: {
		alpha: ["src/alpha/a.ts"],
		beta: ["src/beta/b.ts"],
		[GENERAL_WATCHDOG_ID]: ["src/alpha/a.ts", "src/beta/b.ts"],
	},
};

const domains = [
	{ id: "alpha", name: "Alpha" },
	{ id: "beta", name: "Beta" },
	{ id: GENERAL_WATCHDOG_ID, name: "Lógica e domínio (fluxo)" },
];

describe("buildBusinessSummary", () => {
	test("deriva fluxos por domínio (sem o general) e contratos do AST", () => {
		const summary = buildBusinessSummary({
			classification,
			domains,
			ast: new Map([["src/alpha/a.ts", { facts, delta }]]),
			headSha: "abc123",
			context: { objective: "Entregar o split" },
		});

		expect(summary.source).toBe("deterministic");
		expect(summary.intent).toBe("Entregar o split");
		expect(summary.headSha).toBe("abc123");
		expect(summary.flows.map((flow) => flow.name)).toEqual(["Alpha", "Beta"]);
		expect(summary.flows[0]?.files).toEqual(["src/alpha/a.ts"]);
		expect(summary.flows[0]?.expected).toContain("Contrato");
		expect(summary.contracts).toEqual([
			{
				name: "Contrato",
				sides: ["src/alpha/a.ts"],
				expectation:
					"Declaração `interface` nova — verificar se todos os lados do contrato a honram.",
			},
		]);
	});

	test("sem contexto e sem AST, mantém o esqueleto vazio (nunca inventa)", () => {
		const summary = buildBusinessSummary({ classification, domains });
		expect(summary.intent).toBeUndefined();
		expect(summary.contracts).toEqual([]);
		expect(summary.invariants).toEqual([]);
		expect(summary.flows).toHaveLength(2);
	});
});

describe("parseBusinessSummary", () => {
	test("normaliza listas e preserva a fonte", () => {
		const summary = parseBusinessSummary(
			{
				source: "reviewer",
				intent: "  Entregar Y  ",
				flows: [{ name: "Renovação", trigger: "job", files: ["src/a.ts"] }],
				invariants: ["split sempre presente"],
				contracts: [{ name: "AutomaticPix", sides: ["asaas", "processor"] }],
				states: [{ name: "authorization", transitions: ["ativa → cancelada"] }],
			},
			"deterministic",
		);
		expect(summary?.source).toBe("reviewer");
		expect(summary?.intent).toBe("Entregar Y");
		expect(summary?.flows[0]?.name).toBe("Renovação");
		expect(summary?.invariants).toEqual(["split sempre presente"]);
	});

	test("rejeita documento sem conteúdo útil", () => {
		expect(parseBusinessSummary({})).toBeNull();
		expect(parseBusinessSummary(null)).toBeNull();
		expect(parseBusinessSummary({ flows: [{ name: "" }] })).toBeNull();
	});

	test("corta itens acima do limite e ignora entradas inválidas", () => {
		const summary = parseBusinessSummary({
			intent: "x",
			flows: [
				{ name: "ok" },
				{ name: "" },
				{ name: "outro", files: ["a", 1, "b"] },
			],
		});
		expect(summary?.flows.map((flow) => flow.name)).toEqual(["ok", "outro"]);
		expect(summary?.flows[1]?.files).toEqual(["a", "b"]);
	});
});

describe("buildBusinessBrief", () => {
	test("aponta o output e inclui o schema e o modelo determinístico", () => {
		const summary = buildBusinessSummary({ classification, domains });
		const brief = buildBusinessBrief({
			projectName: "Fake",
			branch: "main",
			headSha: "abc123",
			outputPath: "/tmp/work/review/business-summary.json",
			business: summary,
			files: [
				{
					path: "src/alpha/a.ts",
					status: "modified",
					ranges: [{ start: 3, end: 9 }],
					symbols: ["Contrato"],
				},
			],
			docs: ["AGENTS.md"],
			context: { objective: "Entregar o split" },
		});
		expect(brief).toContain("/tmp/work/review/business-summary.json");
		expect(brief).toContain('"invariants"');
		expect(brief).toContain("Modelo determinístico");
		expect(brief).toContain("src/alpha/a.ts");
		expect(brief).toContain("AGENTS.md");
		expect(brief).toContain('source: "reviewer"');
	});
});

describe("política de severidade (lógica/domínio)", () => {
	const base = {
		file: "src/alpha/a.ts",
		line: 3,
		message: "gap",
		action: "corrigir",
	};

	test("blocking sem cenário+evidência vira attention", () => {
		const warnings: string[] = [];
		const finding = normalizeFinding(
			{
				...base,
				rule: "Domínio: renovação perde o split",
				severity: "blocking",
			},
			(message) => warnings.push(message),
		);
		expect(finding.basis).toBe("domain");
		expect(finding.severity).toBe("attention");
		expect(warnings).toHaveLength(1);
	});

	test("com cenário e evidência, blocking é preservado", () => {
		const finding = normalizeFinding({
			...base,
			rule: "Lógica: subscription sem authorize",
			severity: "blocking",
			scenario: "renovação de assinatura Pix",
			evidence: "this.sendAutomaticPixPayment(data)",
		});
		expect(finding.basis).toBe("logic");
		expect(finding.severity).toBe("blocking");
	});

	test("regra explícita mantém a severidade declarada", () => {
		const finding = normalizeFinding({
			...base,
			rule: "Nunca usar `any`.",
			severity: "blocking",
		});
		expect(finding.basis).toBe("rule");
		expect(finding.severity).toBe("blocking");
	});
});

describe("watchdog general", () => {
	test("resolvido como built-in mesmo sem config", () => {
		const definition = findWatchdog(fakeHoundsmanConfig, GENERAL_WATCHDOG_ID);
		expect(definition?.name).toContain("Lógica");
		expect(definition?.allowEmergentFindings).toBe(true);
		expect(definition?.fallback).toBe(false);
	});

	test("brief inclui intenção, diff e obrigação de output", () => {
		const summary = buildBusinessSummary({ classification, domains });
		const markdown = defaultRenderBrief(
			{
				watchdogId: GENERAL_WATCHDOG_ID,
				files: ["src/alpha/a.ts"],
				statuses: { "src/alpha/a.ts": { status: "modified" as const } },
				deleted: [],
				branch: "main",
				outputPath: "/tmp/findings/general.json",
				outputFormatPath: "OUTPUT-FORMAT.md",
				docs: [],
				business: summary,
				businessSummaryPath: "/tmp/business-summary.json",
				snippets: [{ file: "src/alpha/a.ts", snippet: "@@ -1 +1 @@\n-a\n+b" }],
				flowReview: true,
			},
			generalWatchdog,
		).join("\n");
		expect(markdown).toContain("## Modelo de intenção (negócio)");
		expect(markdown).toContain("## Trechos alterados (diff)");
		expect(markdown).toContain("## Obrigação de output (fluxo)");
		expect(markdown).toContain("/tmp/business-summary.json");
		expect(markdown).toContain("scenario");
	});
});
