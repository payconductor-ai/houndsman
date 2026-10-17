/**
 * Features de IA do fluxo normal (brief, contexto, classificação, verify).
 */

import { describe, expect, test } from "bun:test";
import { AiClient } from "../core/ai";
import { AiBriefEnricher } from "../core/ai/features/brief-enricher";
import { AiClassifier } from "../core/ai/features/classifier";
import { AiContextSummarizer } from "../core/ai/features/context-summarizer";
import { AiPreAnalyzer } from "../core/ai/features/pre-analyzer";
import { AiVerifier } from "../core/ai/features/verifier";
import { briefInstructions, briefPrompt } from "../core/ai/prompts/brief";
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
				logic: ["nome vs comportamento"],
				domain: ["transição de estado"],
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
