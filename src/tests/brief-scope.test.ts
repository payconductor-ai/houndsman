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
import {
	buildBriefSnippets,
	generalFlowFiles,
	shouldSliceGeneral,
	truncatePatch,
} from "../core/engine/prepare-pipeline";
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
	test("preserva etapas, uso de IA e falhas", () => {
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
				attempts: 2,
				failures: [
					{
						feature: "brief",
						model: "deepseek-v4-pro",
						durationMs: 12,
						error: "Resposta truncada",
						finishReason: "length",
					},
				],
			},
		});
		expect(report.version).toBe(1);
		expect(report.durationMs).toBe(1_500);
		expect(report.stages.map((item) => item.stage)).toEqual([
			"business",
			"technical",
		]);
		expect(report.ai?.calls).toBe(1);
		expect(report.ai?.attempts).toBe(2);
		expect(report.ai?.failures[0]?.finishReason).toBe("length");
	});
});

describe("prepare — orçamento de snippets", () => {
	const patch = (chars: number) =>
		Array.from(
			{ length: Math.ceil(chars / 40) },
			() => "+linha de codigo alterada",
		).join("\n");

	test("distribui o teto entre todos os arquivos (não só nos primeiros)", () => {
		const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
		const snippets = buildBriefSnippets(
			files,
			new Map(files.map((file) => [file, patch(2_000)])),
			{ total: 10_000, perFile: 4_000 },
		);
		expect(snippets).toHaveLength(10);
		// Todos começam com uma parte igual; o excedente vai para os primeiros.
		expect(snippets[0]?.snippet.length).toBeGreaterThan(
			snippets[9]?.snippet.length ?? 0,
		);
		expect(snippets.every((item) => item.snippet.length > 0)).toBe(true);
	});

	test("corta em linha inteira e sinaliza o trecho truncado", () => {
		const cut = truncatePatch(patch(1_000), 120);
		expect(cut.length).toBeLessThanOrEqual(120);
		expect(cut).toContain("[trecho truncado");
		expect(cut.startsWith("+linha de codigo")).toBe(true);
		expect(truncatePatch("curto", 100)).toBe("curto");
	});
});

describe("general — recorte por fluxo", () => {
	const flowBusiness: BusinessSummary = {
		source: "ai",
		flows: [
			{
				name: "Renovação",
				trigger: "job",
				expected: "assinatura renovada",
				files: ["./src/alpha/a.ts"],
			},
		],
		invariants: [],
		contracts: [],
		states: [],
	};

	test("dispara por nº de arquivos ou por linhas alteradas", () => {
		const manyFiles = Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`);
		expect(shouldSliceGeneral({ watchdogs: { general: manyFiles }, churn: {} })).toBe(
			true,
		);
		expect(
			shouldSliceGeneral({
				watchdogs: { general: ["src/a.ts"] },
				churn: { "src/a.ts": { additions: 1_200, deletions: 900 } },
			}),
		).toBe(true);
		expect(
			shouldSliceGeneral({
				watchdogs: { general: ["src/a.ts"] },
				churn: { "src/a.ts": { additions: 10, deletions: 5 } },
			}),
		).toBe(false);
	});

	test("prioriza os arquivos dos fluxos e limita o recorte", () => {
		const files = [
			"src/alpha/a.ts",
			...Array.from({ length: 19 }, (_, i) => `src/f${i}.ts`),
		];
		const result = generalFlowFiles(
			{
				watchdogs: { general: files },
				churn: { "src/f19.ts": { additions: 100, deletions: 0 } },
			},
			flowBusiness,
			3,
		);
		expect(result.selected).toHaveLength(3);
		expect(result.selected[0]).toBe("src/alpha/a.ts");
		expect(result.overflow).toHaveLength(17);
	});
});
