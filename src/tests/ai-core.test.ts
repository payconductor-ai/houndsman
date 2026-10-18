/**
 * Fundação de IA: cliente fail-open, budget, provider fake e config.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AiClient, AiUsageBudget, AiUsageRecorder } from "../core/ai";
import { defineHoundsmanConfig } from "../core/config";
import { DEFAULT_AI_MODEL } from "../core/defaults";
import { ProjectConfig } from "../core/project-config";
import { checkRegistry } from "../core/registry-check";
import { FakeModelProvider } from "./fixtures/fake-model-provider";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

const project = new ProjectConfig(fakeHoundsmanConfig);

describe("config de IA", () => {
	test("modelo default do DeepSeek é 4.1 flash", () => {
		expect(DEFAULT_AI_MODEL).toBe("deepseek-v4-pro");
		expect(project.aiModel).toBe("deepseek-v4-pro");
	});
});

describe("AiClient", () => {
	test("sem provider/chave → indisponível e fail-open", async () => {
		const client = new AiClient({ project, provider: null });
		expect(client.available).toBe(false);
		const result = await client.generateObject("x", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(result.ok).toBe(false);
	});

	test("provider fake devolve saída, uso e registra no recorder", async () => {
		const provider = new FakeModelProvider(() => ({ ok: true }));
		const client = new AiClient({ project, provider });
		expect(client.available).toBe(true);
		const result = await client.generateObject("context", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.output.ok).toBe(true);
		expect(client.recorder.total.calls).toBe(1);
		expect(provider.calls).toBe(1);
	});

	test("budget estourado vira fail-open sem chamar o provider", async () => {
		const provider = new FakeModelProvider(() => ({ ok: true }));
		const client = new AiClient({
			project,
			provider,
			budget: new AiUsageBudget({ maxCalls: 0 }),
		});
		const result = await client.generateObject("x", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(result.ok).toBe(false);
		expect(provider.calls).toBe(0);
	});
	describe("validateCredential", () => {
		test("ok, inválida e ausente", async () => {
			const okClient = new AiClient({
				project,
				provider: new FakeModelProvider(() => "OK"),
			});
			expect((await okClient.validateCredential()).kind).toBe("ok");

			const invalid = new AiClient({
				project,
				provider: new FakeModelProvider(() => {
					throw new Error("401 invalid api key");
				}),
			});
			expect((await invalid.validateCredential()).kind).toBe("invalid");

			const missing = new AiClient({ project, provider: null });
			expect((await missing.validateCredential()).kind).toBe("missing");
		});
	});
});

describe("AiUsageBudget / AiUsageRecorder", () => {
	test("acumula uso e bloqueia no teto", () => {
		const budget = new AiUsageBudget({ maxCalls: 2 });
		budget.record({ inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 });
		budget.record({ inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 });
		expect(budget.canCall).toBe(false);
		expect(() => budget.assertCanCall()).toThrow();
	});

	test("recorder serializa total e entradas", () => {
		const recorder = new AiUsageRecorder("deepseek", "fake");
		recorder.record("brief", "fake", {
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			calls: 1,
		});
		const data = recorder.toJSON();
		expect(data.total.calls).toBe(1);
		expect(data.total.totalTokens).toBe(15);
		expect(data.entries[0]?.feature).toBe("brief");
		expect(recorder.serialize()).toContain('"calls": 1');
	});
});

describe("checkRegistry (IA)", () => {
	test("provider inválido é problema; budgets inválidos são aviso", () => {
		const config = defineHoundsmanConfig({
			...fakeHoundsmanConfig,
			ai: { provider: "nope" as never, concurrency: 0 },
		});
		const { problems, warnings } = checkRegistry(config);
		expect(problems.some((item) => item.includes("ai.provider"))).toBe(true);
		expect(warnings.some((item) => item.includes("ai.concurrency"))).toBe(true);
	});
});
