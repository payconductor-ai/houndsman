/**
 * Brief — recorte do modelo de intenção e injeção dos hunks.
 *
 * Depois do `business-brief.md`, cada watchdog recebia o modelo inteiro e
 * perseguia fluxos de outros domínios; o brief também não trazia o código
 * alterado, forçando a releitura dos arquivos. Estes testes congelam o recorte.
 */

import { describe, expect, test } from "bun:test";
import { renderBrief } from "../core/brief";
import { generalWatchdog } from "../core/builtins";
import type { BusinessSummary } from "../core/business-summary";
import { buildPrepareReport } from "../core/prepare-report";
import type { WatchdogRenderArgs } from "../core/types";
import { alphaWatchdog } from "./fixtures/fake-project";

/** Modelo com um fluxo do domínio alpha e outro de fora. */
const business: BusinessSummary = {
	source: "ai",
	intent: "Renovar assinaturas sem perder a credencial da conta.",
	flows: [
		{
			name: "Alpha flow",
			trigger: "webhook de renovação",
			expected: "assinatura renovada",
			files: ["src/alpha/a.ts"],
		},
		{
			name: "Beta flow",
			trigger: "job de cobrança",
			expected: "cobrança criada",
			files: ["src/beta/b.ts"],
		},
	],
	invariants: ["A conta do pagador é preservada."],
	contracts: [],
	states: [],
	openQuestions: ["Pergunta global?"],
};

const baseArgs: WatchdogRenderArgs = {
	watchdogId: "alpha",
	files: ["src/alpha/a.ts"],
	statuses: { "src/alpha/a.ts": { status: "modified" } },
	deleted: [],
	branch: "feature/x",
	outputPath: "findings/alpha.json",
	outputFormatPath: "OUTPUT-FORMAT.md",
	docs: [],
	business,
	businessSummaryPath: "/home/.houndsman/work/review/business-summary.json",
	snippets: [
		{
			file: "src/alpha/a.ts",
			snippet: "@@ -1 +1 @@\n-const a = 1;\n+const a: any = 1;",
		},
	],
};

describe("brief — recorte do modelo de intenção", () => {
	test("watchdog de domínio vê só os fluxos dos seus arquivos", () => {
		const markdown = renderBrief(alphaWatchdog, baseArgs);
		expect(markdown).toContain("Alpha flow");
		expect(markdown).not.toContain("Beta flow");
		expect(markdown).toContain("1 fluxo(s) fora do seu domínio foram omitidos");
		expect(markdown).toContain("não os investigue");
	});

	test("domínio não recebe o caminho canônico (evita leitura extra)", () => {
		const markdown = renderBrief(alphaWatchdog, baseArgs);
		expect(markdown).not.toContain("business-summary.json");
	});

	test("general recebe o modelo completo e o caminho canônico", () => {
		const markdown = renderBrief(generalWatchdog, {
			...baseArgs,
			watchdogId: generalWatchdog.id,
			files: ["src/alpha/a.ts", "src/beta/b.ts"],
		});
		expect(markdown).toContain("Alpha flow");
		expect(markdown).toContain("Beta flow");
		expect(markdown).toContain("Pergunta global?");
		expect(markdown).toContain("business-summary.json");
	});
});

describe("brief — trechos alterados", () => {
	test("injeta o diff e proíbe reler o arquivo inteiro", () => {
		const markdown = renderBrief(alphaWatchdog, baseArgs);
		expect(markdown).toContain("## Trechos alterados (diff)");
		expect(markdown).toContain("const a: any = 1;");
		expect(markdown).toContain("não abra os arquivos");
	});

	test("sem trechos, a seção não aparece", () => {
		const markdown = renderBrief(alphaWatchdog, {
			...baseArgs,
			snippets: undefined,
		});
		expect(markdown).not.toContain("## Trechos alterados (diff)");
	});
});

describe("prepare-report", () => {
	test("preserva etapas e uso de IA", () => {
		const report = buildPrepareReport({
			startedAt: "2026-10-25T00:00:00.000Z",
			durationMs: 1_500,
			stages: [
				{ stage: "business", durationMs: 900 },
				{ stage: "technical", durationMs: 300 },
			],
			ai: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				calls: 1,
			},
		});
		expect(report.version).toBe(1);
		expect(report.durationMs).toBe(1_500);
		expect(report.stages.map((item) => item.stage)).toEqual([
			"business",
			"technical",
		]);
		expect(report.ai?.calls).toBe(1);
	});
});
