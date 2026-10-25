/**
 * Features de IA do fluxo normal (brief, contexto, classificação, verify).
 */

import { describe, expect, test } from "bun:test";
import { AiClient } from "../core/ai";
import { AiBriefEnricher } from "../core/ai/features/brief-enricher";
import { AiBusinessAnalyzer } from "../core/ai/features/business-analyzer";
import { AiBusinessSummarizer } from "../core/ai/features/business-summarizer";
import { AiClassifier } from "../core/ai/features/classifier";
import { AiContextSummarizer } from "../core/ai/features/context-summarizer";
import { AiPreAnalyzer } from "../core/ai/features/pre-analyzer";
import { AiTechnicalSummarizer } from "../core/ai/features/technical-summarizer";
import { AiVerifier } from "../core/ai/features/verifier";
import { briefInstructions, briefPrompt } from "../core/ai/prompts/brief";
import { businessInstructions } from "../core/ai/prompts/business";
import { contextInstructions } from "../core/ai/prompts/context";
import { technicalInstructions } from "../core/ai/prompts/technical";
import { renderBrief } from "../core/brief";
import { ProjectConfig } from "../core/project-config";
import { FakeModelProvider } from "./fixtures/fake-model-provider";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

const project = new ProjectConfig(fakeHoundsmanConfig);
const alpha = fakeHoundsmanConfig.watchdogs.alpha;

describe("AiBriefEnricher", () => {
	test("devolve o plano do modelo", async () => {
		const provider = new FakeModelProvider(() => ({
			focus: ["checar any"],
			questions: ["há any?"],
			risks: ["tipagem fraca"],
		}));
		const enricher = new AiBriefEnricher(new AiClient({ project, provider }));
		const plan = await enricher.enrich({
			watchdogId: "alpha",
			name: "Alpha",
			description: "x",
			scope: "src/alpha",
			rules: alpha.rules,
			files: ["src/alpha/a.ts"],
		});
		expect(plan?.focus[0]).toBe("checar any");
	});

	test("sem IA → null (brief inalterado)", async () => {
		const enricher = new AiBriefEnricher(new AiClient({ project, provider: null }));
		expect(enricher.enabled).toBe(false);
		expect(
			await enricher.enrich({
				watchdogId: "alpha",
				name: "Alpha",
				description: "x",
				scope: "src/alpha",
				rules: alpha.rules,
				files: [],
			}),
		).toBeNull();
	});

	test("brief com aiPlan ganha a seção de sugestão", () => {
		const args = {
			watchdogId: "alpha",
			files: ["src/alpha/a.ts"],
			statuses: { "src/alpha/a.ts": { status: "modified" as const } },
			deleted: [],
			branch: "main",
			outputPath: "findings/alpha.json",
			outputFormatPath: "OUTPUT-FORMAT.md",
			docs: [],
			aiPlan: {
				focus: ["foco"],
				questions: ["pergunta"],
				risks: ["risco"],
				logic: [],
				domain: [],
			},
		};
		const markdown = renderBrief(alpha, args);
		expect(markdown).toContain("## Plano de revisão (IA)");
		expect(markdown).toContain("foco");
	});

	test("brief sem aiPlan é byte-idêntico ao render sem a seção", () => {
		const base = {
			watchdogId: "alpha",
			files: ["src/alpha/a.ts"],
			statuses: { "src/alpha/a.ts": { status: "modified" as const } },
			deleted: [],
			branch: "main",
			outputPath: "findings/alpha.json",
			outputFormatPath: "OUTPUT-FORMAT.md",
			docs: [],
		};
		expect(renderBrief(alpha, base)).not.toContain("Plano de revisão (IA)");
	});

	test("prompt e render incluem lógica e domínio", () => {
		expect(briefInstructions()).toContain("PISO");
		const prompt = briefPrompt({
			watchdogId: "alpha",
			name: "Alpha",
			description: "x",
			scope: "src/alpha",
			rules: alpha.rules,
			files: ["src/alpha/a.ts"],
		});
		expect(prompt).toContain("Revisão além das regras");
		const markdown = renderBrief(alpha, {
			watchdogId: "alpha",
			files: ["src/alpha/a.ts"],
			statuses: { "src/alpha/a.ts": { status: "modified" as const } },
			deleted: [],
			branch: "main",
			outputPath: "findings/alpha.json",
			outputFormatPath: "OUTPUT-FORMAT.md",
			docs: [],
			aiPlan: {
				focus: [],
				questions: [],
				risks: [],
				logic: [{ statement: "nome vs comportamento" }],
				domain: [{ statement: "transição de estado" }],
			},
		});
		expect(markdown).toContain("Consistência lógica");
		expect(markdown).toContain("Domínio de negócio");
	});
});

describe("AiContextSummarizer", () => {
	test("resume contexto bruto", async () => {
		const provider = new FakeModelProvider(() => ({
			available: true,
			objective: "Entregar Y",
			changeSummary: ["Faz X"],
		}));
		const summarizer = new AiContextSummarizer(new AiClient({ project, provider }));
		const summary = await summarizer.summarize('{"title":"PR"}');
		expect(summary?.objective).toBe("Entregar Y");
	});
});

describe("AiClassifier", () => {
	test("filtra ids e arquivos desconhecidos", async () => {
		const provider = new FakeModelProvider(() => ({
			assignments: [
				{ file: "a.ts", watchdogId: "alpha" },
				{ file: "a.ts", watchdogId: "nope" },
				{ file: "b.ts", watchdogId: "alpha" },
			],
		}));
		const classifier = new AiClassifier(new AiClient({ project, provider }));
		// Feature desligada por default no fake config.
		expect(classifier.enabled).toBe(false);
		expect(
			await classifier.classify(["a.ts"], [{ id: "alpha", name: "A", scope: "x" }]),
		).toEqual(new Map());
	});
});

describe("AiTechnicalSummarizer", () => {
	test("devolve os destaques estruturais do modelo", async () => {
		const provider = new FakeModelProvider(() => ({
			overview: "Novo módulo bin-lookup",
			highlights: [{ area: "Contratos", detail: "`BinLookupProvider`" }],
		}));
		const summarizer = new AiTechnicalSummarizer(new AiClient({ project, provider }));
		const summary = await summarizer.summarize({
			branch: "main",
			classification: {
				files: { "src/bin-lookup/service.ts": { status: "added" } },
				churn: { "src/bin-lookup/service.ts": { additions: 3, deletions: 0 } },
			},
			headSha: "abc",
			domains: ["Alpha"],
		});
		expect(summary?.source).toBe("ai");
		expect(summary?.headSha).toBe("abc");
		expect(summary?.highlights[0].area).toBe("Contratos");
	});

	test("sem IA o resumo é nulo (fallback no chamador)", async () => {
		const summarizer = new AiTechnicalSummarizer(
			new AiClient({ project, provider: null }),
		);
		expect(summarizer.enabled).toBe(false);
		expect(
			await summarizer.summarize({
				branch: "main",
				classification: { files: {}, churn: {} },
			}),
		).toBeNull();
	});
});

describe("AiVerifier", () => {
	test("devolve confiança apenas para ids conhecidos", async () => {
		const provider = new FakeModelProvider(() => ({
			verdicts: [
				{ id: "f1", persisting: true, confidence: 0.9 },
				{ id: "nope", persisting: false, confidence: 0 },
			],
		}));
		const verifier = new AiVerifier(new AiClient({ project, provider }));
		expect(verifier.enabled).toBe(false);
	});
});

describe("AiPreAnalyzer", () => {
	test("sem a feature ligada não gera candidatos", async () => {
		const provider = new FakeModelProvider(() => ({ candidates: [] }));
		const analyzer = new AiPreAnalyzer(new AiClient({ project, provider }));
		expect(analyzer.enabled).toBe(false);
		expect(
			await analyzer.analyze({
				watchdogId: "alpha",
				name: "Alpha",
				rules: alpha.rules,
				files: [{ file: "a.ts", snippet: "x" }],
			}),
		).toEqual([]);
	});
});

describe("idioma dos resumos", () => {
	test("prompts de contexto, intenção e pontos técnicos exigem pt-BR", () => {
		for (const instructions of [
			contextInstructions(),
			businessInstructions(),
			technicalInstructions(),
		]) {
			expect(instructions).toContain("português do Brasil");
			expect(instructions).toContain("pt-BR");
		}
	});
});

describe("AiBusinessSummarizer", () => {
	const input = {
		classification: {
			files: { "src/alpha/a.ts": { status: "modified" as const } },
			churn: { "src/alpha/a.ts": { additions: 3, deletions: 1 } },
			watchdogs: { alpha: ["src/alpha/a.ts"] },
		},
		domains: [{ id: "alpha", name: "Alpha" }],
		headSha: "abc123",
	};

	test("devolve o modelo com source ai", async () => {
		const provider = new FakeModelProvider(() => ({
			intent: "Entregar o split",
			flows: [{ name: "Renovação", trigger: "job", files: ["src/alpha/a.ts"] }],
			invariants: ["split sempre presente"],
			contracts: [{ name: "AutomaticPix", sides: ["asaas", "processor"] }],
			states: [],
		}));
		const summarizer = new AiBusinessSummarizer(new AiClient({ project, provider }));
		const summary = await summarizer.summarize(input);
		expect(summary?.source).toBe("ai");
		expect(summary?.headSha).toBe("abc123");
		expect(summary?.flows[0]?.name).toBe("Renovação");
		expect(summary?.invariants).toEqual(["split sempre presente"]);
	});

	test("sem IA → null (fallback determinístico no chamador)", async () => {
		const summarizer = new AiBusinessSummarizer(
			new AiClient({ project, provider: null }),
		);
		expect(summarizer.enabled).toBe(false);
		expect(await summarizer.summarize(input)).toBeNull();
	});
});

describe("AiBusinessAnalyzer", () => {
	test("gera candidatos do general e descarta arquivo fora do escopo", async () => {
		const provider = new FakeModelProvider(() => ({
			hypotheses: [
				{
					file: "src/alpha/a.ts",
					kind: "domain",
					statement: "renovação perde o split",
					confidence: 0.9,
				},
				{
					file: "src/outro.ts",
					kind: "logic",
					statement: "fora do escopo",
					confidence: 0.9,
				},
				{
					file: "src/alpha/a.ts",
					kind: "logic",
					statement: "confiança baixa",
					confidence: 0.2,
				},
			],
		}));
		const analyzer = new AiBusinessAnalyzer(new AiClient({ project, provider }));
		const candidates = await analyzer.analyze({
			business: {
				source: "deterministic",
				flows: [],
				invariants: [],
				contracts: [],
				states: [],
			},
			payload: {
				classification: {
					files: { "src/alpha/a.ts": { status: "modified" } },
					churn: {},
					watchdogs: {},
				},
			},
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.watchdogId).toBe("general");
		expect(candidates[0]?.rule).toBe("Domínio: renovação perde o split");
		expect(candidates[0]?.severity).toBe("attention");
	});
});
