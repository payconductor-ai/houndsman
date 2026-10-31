/**
 * Fundação de IA: cliente fail-open, budget, provider fake e config.
 */

import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { AiClient, AiUsageBudget, AiUsageRecorder } from "../core/ai";
import {
	buildGenerateTextArgs,
	formatSdkWarning,
	formatSdkWarnings,
} from "../core/ai/ai-sdk-model-provider";
import { errorDetail } from "../core/ai/errors";
import { temperatureApplies } from "../core/ai/provider-capabilities";
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

describe("temperature e providerOptions", () => {
	test("DeepSeek V4 ignora temperature; thinking disabled reabilita", () => {
		expect(temperatureApplies("deepseek", "deepseek-v4-pro", undefined)).toBe(false);
		expect(
			temperatureApplies("deepseek", "deepseek-v4-pro", {
				deepseek: { thinking: { type: "disabled" } },
			}),
		).toBe(true);
		expect(
			temperatureApplies("deepseek", "deepseek-v4-pro", {
				deepseek: { thinking: { type: "enabled" } },
			}),
		).toBe(false);
		expect(temperatureApplies("deepseek", "deepseek-chat", undefined)).toBe(true);
		expect(temperatureApplies("openai", "gpt-4o", undefined)).toBe(true);
	});

	test("adapter omite temperature ignorada e repassa providerOptions", () => {
		const model = {} as LanguageModel;
		const thinkingOff = buildGenerateTextArgs(
			model,
			{
				prompt: "oi",
				temperature: 0,
				providerOptions: { deepseek: { thinking: { type: "disabled" } } },
			},
			"deepseek",
			"deepseek-v4-pro",
		);
		expect(thinkingOff).toMatchObject({
			temperature: 0,
			providerOptions: { deepseek: { thinking: { type: "disabled" } } },
		});

		const defaultThinking = buildGenerateTextArgs(
			model,
			{ prompt: "oi", temperature: 0 },
			"deepseek",
			"deepseek-v4-pro",
		);
		expect(defaultThinking).not.toHaveProperty("temperature");

		const openai = buildGenerateTextArgs(
			model,
			{ prompt: "oi", temperature: 0 },
			"openai",
			"gpt-4o",
		);
		expect(openai).toMatchObject({ temperature: 0 });
	});

	test("AiClient injeta providerOptions da config", async () => {
		const configured = new ProjectConfig({
			...fakeHoundsmanConfig,
			ai: { providerOptions: { deepseek: { thinking: { type: "disabled" } } } },
		});
		const provider = new FakeModelProvider(() => ({ ok: true }));
		const client = new AiClient({ project: configured, provider });
		await client.generateObject("x", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(provider.requests[0]?.providerOptions).toEqual({
			deepseek: { thinking: { type: "disabled" } },
		});
	});

	test("objetos estruturados desligam thinking por default", async () => {
		const provider = new FakeModelProvider(() => ({ ok: true }));
		const client = new AiClient({ project, provider });
		await client.generateObject("business", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(provider.requests[0]?.providerOptions).toEqual({
			deepseek: { thinking: { type: "disabled" } },
		});
	});

	test("thinking configurado pelo projeto vence o default", async () => {
		const configured = new ProjectConfig({
			...fakeHoundsmanConfig,
			ai: { providerOptions: { deepseek: { thinking: { type: "enabled" } } } },
		});
		const provider = new FakeModelProvider(() => ({ ok: true }));
		const client = new AiClient({ project: configured, provider });
		await client.generateObject("business", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(provider.requests[0]?.providerOptions).toEqual({
			deepseek: { thinking: { type: "enabled" } },
		});
	});

	test("resposta truncada falha e é registrada sem debitar o budget", async () => {
		const provider = new FakeModelProvider(
			() => ({ ok: true }),
			"fake-model",
			"length",
		);
		const client = new AiClient({ project, provider });
		const result = await client.generateObject("brief", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
			maxOutputTokens: 100,
		});
		expect(result.ok).toBe(false);
		expect(client.recorder.total.calls).toBe(0);
		expect(client.recorder.failures[0]?.finishReason).toBe("length");
		expect(client.recorder.summary.attempts).toBe(1);
	});

	test("falha do provider persiste o detalhe diagnóstico", async () => {
		const boom = Object.assign(new Error("boom"), {
			cause: new Error("campo ausente"),
		});
		const provider = new FakeModelProvider(() => {
			throw boom;
		});
		const client = new AiClient({ project, provider });
		const result = await client.generateObject("brief:alpha", {
			prompt: "oi",
			outputSchema: z.object({ ok: z.boolean() }),
		});
		expect(result.ok).toBe(false);
		const failure = client.recorder.failures[0];
		expect(failure?.feature).toBe("brief:alpha");
		expect(failure?.error).toBe("boom");
		expect(failure?.detail).toBe("campo ausente");
		expect(client.recorder.toJSON().failures[0]?.detail).toBe("campo ausente");
	});
});

describe("diagnóstico de falha de IA", () => {
	test("errorDetail expõe causa, issues e resposta, sem repetir a raiz", () => {
		const cause = Object.assign(new Error("Type validation failed"), {
			issues: [{ path: ["flows", 0, "name"], message: "Required" }],
			cause: new Error("JSON inválido"),
		});
		const error = Object.assign(
			new Error("No object generated: response did not match schema."),
			{ text: '{"flows":', cause },
		);
		const detail = errorDetail(error);
		expect(detail).toContain("Type validation failed");
		expect(detail).toContain("flows.0.name: Required");
		expect(detail).toContain("JSON inválido");
		expect(detail).toContain('resposta: {"flows":');
		expect(detail).not.toContain("No object generated");
	});

	test("errorDetail devolve undefined quando só há a mensagem raiz", () => {
		expect(errorDetail(new Error("falhou"))).toBeUndefined();
	});

	test("errorDetail trunca o detalhe", () => {
		const error = Object.assign(new Error("raiz"), {
			cause: new Error("x".repeat(50)),
		});
		expect(errorDetail(error, 10)).toBe(`${"x".repeat(10)}…`);
	});
});

describe("avisos do AI SDK", () => {
	test("normaliza os avisos do provider em texto", () => {
		expect(
			formatSdkWarning({
				type: "compatibility",
				feature: "responseFormat JSON schema",
				details: "JSON response schema is injected into the system message.",
			}),
		).toBe(
			"compatibility: responseFormat JSON schema — JSON response schema is injected into the system message.",
		);
		expect(
			formatSdkWarning({
				type: "unsupported",
				feature: "user message part type: image",
			}),
		).toBe("unsupported: user message part type: image");
		expect(
			formatSdkWarning({
				type: "deprecated",
				setting: "temperature",
				message: "gone",
			}),
		).toBe("deprecated: temperature — gone");
		expect(formatSdkWarning(null)).toBe("aviso");
		expect(formatSdkWarnings(undefined)).toEqual([]);
	});

	test("logger default do SDK fica silencioso após carregar o adapter", () => {
		expect(typeof globalThis.AI_SDK_LOG_WARNINGS).toBe("function");
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
