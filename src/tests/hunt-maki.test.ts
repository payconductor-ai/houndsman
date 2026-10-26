/**
 * Harness local — prompt, parser de saída, runner e política de retry.
 *
 * Testa o `core/hunt` sem processo real: o `MakiProcessRunner` é injetado.
 * A execução via `Bun.spawn` é coberta em plataformas POSIX nos testes abaixo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineHoundsmanConfig } from "../core/config";
import { type HuntEvent, HuntRunner } from "../core/hunt/hunt-runner";
import { requireMakiModel, resolveMakiModel } from "../core/hunt/maki-model";
import {
	renderAdversarialPrompt,
	renderBookkeepingPrompt,
	renderChecklistSuffix,
	renderHuntPrompt,
	renderResumeSuffix,
} from "../core/hunt/maki-prompt";
import {
	extractJsonObject,
	MAKI_DISALLOWED_TOOLS,
	MAKI_REVIEW_SYSTEM_PROMPT,
	makiArgs,
	parseMakiOutput,
	SpawnMakiRunner,
} from "../core/hunt/maki-runner";
import {
	briefRules,
	businessScore,
	chooseBusinessSummary,
	expectedReviewItems,
	mergeFindings,
	missingReviewItems,
	missingRuleChecks,
	parseReviewChecks,
	parseRuleChecks,
	summarizeRuleChecks,
	withInferredRule,
} from "../core/hunt/review-checks";
import { ProjectConfig } from "../core/project-config";
import type { ReviewRecord } from "../core/storage/types";
import { ReviewWorkArea } from "../core/storage/work-area";
import { defineWatchdog } from "../core/types";

const config = defineHoundsmanConfig({
	projectName: "Hunt Test",
	watchdogs: {
		alpha: defineWatchdog({
			id: "alpha",
			name: "Alpha",
			description: "alpha",
			scope: "src/alpha/**",
			classify: [{ value: "^src/alpha/" }],
			rules: [{ severity: "attention", text: "Evitar any." }],
			contextFiles: [],
		}),
		beta: defineWatchdog({
			id: "beta",
			name: "Beta",
			description: "beta",
			scope: "src/beta/**",
			classify: [{ value: "^src/beta/" }],
			rules: [{ severity: "attention", text: "Evitar console.log." }],
			contextFiles: [],
		}),
	},
	exclusions: [],
	docMappings: [],
});

const project = new ProjectConfig(config);

/** Review fake (o staging só precisa de id/branch). */
function fakeReview(root: string): ReviewRecord {
	const now = "2026-01-01T00:00:00.000Z";
	return {
		id: "review-hunt",
		repoKey: "repo",
		repoRoot: root,
		branch: "main",
		slug: "main",
		status: "reviewing",
		createdAt: now,
		updatedAt: now,
	};
}

/** Staging temporário com briefs prontos. */
function makeWork(ids: string[]): {
	root: string;
	work: ReviewWorkArea;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "houndsman-hunt-"));
	const work = new ReviewWorkArea(fakeReview(root), root);
	work.ensure();
	// Arquivos reais: o checklist agora só aceita `at` que existe em disco.
	const files = new Set(["src/alpha/a.ts", ...ids.map((id) => `src/${id}/a.ts`)]);
	for (const file of files) {
		mkdirSync(join(root, "src", file.split("/")[1]), { recursive: true });
		writeFileSync(join(root, file), "linha 1\nlinha 2\nlinha 3\n", "utf8");
	}
	for (const id of ids) work.writeBrief(id, `brief de ${id}`);
	return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function reportJson(watchdogId: string, findings = 1): string {
	return JSON.stringify({
		watchdogId,
		reviewedFiles: [`src/${watchdogId}/a.ts`],
		skipped: [],
		findings: Array.from({ length: findings }, (_, index) => ({
			rule: "Evitar any",
			severity: "attention",
			file: `src/${watchdogId}/a.ts`,
			line: index + 1,
			message: "any detectado",
			action: "tipar",
		})),
	});
}

describe("maki — contrato de execução", () => {
	test("args são headless e negam escrita/bash/rede sem yolo/trust", () => {
		const args = makiArgs("deepseek/deepseek-v4-pro");
		expect(args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--model",
			"deepseek/deepseek-v4-pro",
			"--disallowed-tools",
			MAKI_DISALLOWED_TOOLS,
			"--append-system-prompt",
			MAKI_REVIEW_SYSTEM_PROMPT,
		]);
		expect(args).not.toContain("--yolo");
		expect(args).not.toContain("--trust");
		expect(MAKI_REVIEW_SYSTEM_PROMPT).toContain("Profundidade vence brevidade");
		for (const tool of ["bash", "write", "edit", "task", "webfetch"]) {
			expect(MAKI_DISALLOWED_TOOLS.split(",")).toContain(tool);
		}
	});

	test("prompt inclui brief e proíbe escrita", () => {
		const prompt = renderHuntPrompt({
			projectName: "Proj",
			watchdogId: "alpha",
			brief: "# Brief alpha",
		});
		expect(prompt).toContain("# Brief alpha");
		expect(prompt).toContain("não escreva arquivos");
		expect(prompt).toContain('"watchdogId": "alpha"');
	});

	test("resume entra nos args do maki e o sufixo é compacto", () => {
		expect(makiArgs("deepseek/deepseek-v4-pro", "sess-1")).toContain("--resume");
		expect(makiArgs("deepseek/deepseek-v4-pro", "sess-1")).toContain("sess-1");
		expect(makiArgs("deepseek/deepseek-v4-pro")).not.toContain("--resume");
		const suffix = renderResumeSuffix("sem JSON", "alpha");
		expect(suffix).toContain("sessão retomada");
		expect(suffix).toContain('"watchdogId": "alpha"');
		expect(suffix).not.toContain("## Brief");
	});

	test("extrai JSON puro, cercado por markdown ou texto", () => {
		const payload = { watchdogId: "alpha", findings: [] };
		expect(extractJsonObject(JSON.stringify(payload))).toEqual(payload);
		expect(
			extractJsonObject(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``),
		).toEqual(payload);
		expect(extractJsonObject(`Aqui está:\n${JSON.stringify(payload)}\nfim`)).toEqual(
			payload,
		);
		expect(extractJsonObject("sem json")).toBeNull();
	});

	test("extrai o último objeto quando o result concatena a narração do agente", () => {
		const first = { businessSummary: { flows: [] }, note: "rascunho" };
		const last = { watchdogId: "general", findings: [] };
		const transcript = [
			"Vou revisar o diff. {isso não é JSON}",
			JSON.stringify(first),
			"Agora tenho evidências. Segue o relatório:",
			`\`\`\`json\n${JSON.stringify(last, null, 2)}\n\`\`\``,
		].join("\n");
		expect(extractJsonObject(transcript)).toEqual(last);

		const withoutFence = `narração com { e } no meio\n${JSON.stringify(first)}\nfinal:\n${JSON.stringify(last)}`;
		expect(extractJsonObject(withoutFence)).toEqual(last);
	});

	test("parseia o JSON do maki (linha única e multi-linha)", () => {
		const single = '{"type":"result","result":"ok","session_id":"s1"}';
		expect(parseMakiOutput(single)?.result).toBe("ok");

		const pretty = JSON.stringify(
			{ type: "result", result: "ok", total_cost_usd: 0.5 },
			null,
			2,
		);
		expect(parseMakiOutput(pretty)?.total_cost_usd).toBe(0.5);
		expect(parseMakiOutput(`log\n${single}`)?.session_id).toBe("s1");
		expect(parseMakiOutput(`log antes\n${pretty}\nlog depois`)?.result).toBe("ok");
		expect(parseMakiOutput("nada")).toBeNull();
	});
});

describe("maki — modelo e credencial", () => {
	const original = {
		deepseek: process.env.HOUNDSMAN_DEEP_SEEK_API_KEY,
		openai: process.env.HOUNDSMAN_OPENAI_API_KEY,
	};

	afterEach(() => {
		if (original.deepseek === undefined)
			delete process.env.HOUNDSMAN_DEEP_SEEK_API_KEY;
		else process.env.HOUNDSMAN_DEEP_SEEK_API_KEY = original.deepseek;
		if (original.openai === undefined) delete process.env.HOUNDSMAN_OPENAI_API_KEY;
		else process.env.HOUNDSMAN_OPENAI_API_KEY = original.openai;
	});

	test("deriva deepseek/<model> e injeta DEEPSEEK_API_KEY", () => {
		process.env.HOUNDSMAN_DEEP_SEEK_API_KEY = "sk-deepseek";
		const model = requireMakiModel(project);
		expect(model.spec).toBe("deepseek/deepseek-v4-pro");
		expect(model.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
		expect(model.apiKey).toBe("sk-deepseek");
	});

	test("prefixo reconhecido troca provider e credencial", () => {
		process.env.HOUNDSMAN_OPENAI_API_KEY = "sk-openai";
		const model = resolveMakiModel(project, "openai/gpt-5");
		expect(model.spec).toBe("openai/gpt-5");
		expect(model.provider).toBe("openai");
		expect(model.apiKeyEnv).toBe("OPENAI_API_KEY");
		expect(model.apiKey).toBe("sk-openai");
	});

	test("sem chave, requireMakiModel falha com a env correta", () => {
		delete process.env.HOUNDSMAN_DEEP_SEEK_API_KEY;
		expect(() => requireMakiModel(project)).toThrow("HOUNDSMAN_DEEP_SEEK_API_KEY");
	});
});

describe("HuntRunner", () => {
	test("grava findings e agrega métricas", async () => {
		const staging = makeWork(["alpha", "beta"]);
		try {
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 2,
				timeoutMs: 10_000,
				retries: 1,
				runner: {
					run: async (request) => {
						const id = request.prompt.includes("brief de alpha")
							? "alpha"
							: "beta";
						return {
							ok: true,
							text: reportJson(id),
							metrics: {
								durationMs: 10,
								costUsd: 0.01,
								sessionId: `s-${id}`,
								numTurns: 2,
								usage: {
									totalTokens: 100,
									inputTokens: 60,
									outputTokens: 40,
								},
							},
							stderr: "",
							exitCode: 0,
						};
					},
				},
			});

			const report = await runner.run(["alpha", "beta"]);
			expect(report.totals.watchdogs).toBe(2);
			expect(report.totals.done).toBe(2);
			expect(report.totals.failed).toBe(0);
			expect(report.totals.findings).toBe(2);
			expect(report.totals.costUsd).toBeCloseTo(0.02);
			expect(report.totals.totalTokens).toBe(200);
			expect(staging.work.readFindings(["alpha", "beta"]).pending).toEqual([]);
		} finally {
			staging.cleanup();
		}
	});

	test("pré-passe de intenção grava o modelo antes dos watchdogs", async () => {
		const staging = makeWork(["alpha"]);
		staging.work.writeBusinessBrief("# Brief de intenção");
		try {
			let intentCalls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async (request) => {
						if (request.prompt.includes("passo de intenção")) {
							intentCalls++;
							return {
								ok: true,
								text: JSON.stringify({
									intent: "Entregar o split",
									flows: [
										{ name: "Renovação", files: ["src/alpha/a.ts"] },
									],
									invariants: ["split sempre presente"],
									contracts: [],
									states: [],
								}),
								metrics: { durationMs: 5 },
								stderr: "",
								exitCode: 0,
							};
						}
						return {
							ok: true,
							text: reportJson("alpha"),
							metrics: { durationMs: 5 },
							stderr: "",
							exitCode: 0,
						};
					},
				},
			});

			const report = await runner.run(["alpha"]);
			expect(intentCalls).toBe(1);
			expect(report.business).toBe("reviewer");
			const summary = staging.work.readBusinessSummary();
			expect(summary?.source).toBe("reviewer");
			expect(summary?.intent).toBe("Entregar o split");
			expect(summary?.invariants).toEqual(["split sempre presente"]);
		} finally {
			staging.cleanup();
		}
	});

	test("repete uma vez quando a saída não tem JSON válido", async () => {
		const staging = makeWork(["alpha"]);
		try {
			const prompts: string[] = [];
			let calls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 1,
				runner: {
					run: async (request) => {
						prompts.push(request.prompt);
						calls++;
						return calls === 1
							? {
									ok: true,
									text: "não é json",
									metrics: { durationMs: 5 },
									stderr: "",
									exitCode: 0,
								}
							: {
									ok: true,
									text: reportJson("alpha"),
									metrics: { durationMs: 5 },
									stderr: "",
									exitCode: 0,
								};
					},
				},
			});

			const report = await runner.run(["alpha"]);
			expect(calls).toBe(2);
			expect(report.watchdogs[0].attempts).toBe(2);
			expect(report.watchdogs[0].status).toBe("done");
			expect(prompts[1]).toContain("Correção obrigatória");
		} finally {
			staging.cleanup();
		}
	});

	test("emite evento de retry antes da segunda tentativa", async () => {
		const staging = makeWork(["alpha"]);
		try {
			const events: HuntEvent[] = [];
			let calls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 1,
				onEvent: (event) => events.push(event),
				runner: {
					run: async () => {
						calls++;
						return calls === 1
							? {
									ok: true,
									text: "não é json",
									metrics: { durationMs: 5 },
									stderr: "",
									exitCode: 0,
								}
							: {
									ok: true,
									text: reportJson("alpha"),
									metrics: { durationMs: 5 },
									stderr: "",
									exitCode: 0,
								};
					},
				},
			});

			await runner.run(["alpha"]);
			const retry = events.find((event) => event.type === "retry");
			expect(retry).toMatchObject({
				type: "retry",
				watchdogId: "alpha",
				attempt: 1,
				maxAttempts: 2,
			});
			expect(events.some((event) => event.type === "done")).toBe(true);
		} finally {
			staging.cleanup();
		}
	});

	test("falha após os retries e não grava findings", async () => {
		const staging = makeWork(["alpha"]);
		try {
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 1,
				runner: {
					run: async () => ({
						ok: true,
						text: "{}",
						metrics: { durationMs: 1 },
						stderr: "",
						exitCode: 0,
					}),
				},
			});

			const report = await runner.run(["alpha"]);
			expect(report.watchdogs[0].status).toBe("failed");
			expect(report.watchdogs[0].error).toContain("watchdogId");
			expect(existsSync(staging.work.findingFile("alpha"))).toBe(false);
		} finally {
			staging.cleanup();
		}
	});

	test("watchdogId divergente é rejeitado", async () => {
		const staging = makeWork(["alpha"]);
		try {
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async () => ({
						ok: true,
						text: reportJson("beta"),
						metrics: { durationMs: 1 },
						stderr: "",
						exitCode: 0,
					}),
				},
			});

			const report = await runner.run(["alpha"]);
			expect(report.watchdogs[0].status).toBe("failed");
			expect(report.watchdogs[0].error).toContain("não corresponde");
		} finally {
			staging.cleanup();
		}
	});
});

/** Brief mínimo com a seção de arquivos do domínio (usada pelo checklist). */
function briefWithFiles(id: string, files: string[], rules: string[] = []): string {
	return [
		`# Brief — ${id}`,
		"",
		`## Arquivos do seu domínio (${files.length})`,
		"",
		...files.map((file) => `- \`${file}\` (modified, +10/−0)`),
		"",
		...(rules.length > 0
			? [
					"## Regras (por severidade)",
					"",
					...rules.map(
						(rule, index) => `- ${index + 1}. ⚠️ **attention** — ${rule}`,
					),
					"",
				]
			: []),
		"## Procedimento",
		"",
	].join("\n");
}

describe("harness — checklist de intenção", () => {
	const business = {
		source: "ai" as const,
		intent: "Entregar split",
		flows: [
			{ name: "Criação de subconta", files: ["src/alpha/a.ts"] },
			{ name: "Fluxo beta", files: ["src/beta/b.ts"] },
		],
		invariants: ["Split sempre presente"],
		contracts: [],
		states: [],
	};

	test("prompt declara protocolo, calibração e o campo checks", () => {
		const prompt = renderHuntPrompt({
			projectName: "Proj",
			watchdogId: "alpha",
			brief: "# Brief alpha",
		});
		expect(prompt).toContain("## Protocolo de revisão");
		expect(prompt).toContain("AUTOVERIFICAÇÃO");
		expect(prompt).toContain('"checks"');
		expect(prompt).toContain("blocking`");
	});

	test("sufixo de checklist lista os itens pendentes", () => {
		const suffix = renderChecklistSuffix(["Split sempre presente"]);
		expect(suffix).toContain("Verificação obrigatória (checklist)");
		expect(suffix).toContain("- Split sempre presente");
		expect(suffix).toContain("relatório **completo**");
	});

	test("itens esperados recortam fluxos por domínio e mantêm invariantes", () => {
		const brief = briefWithFiles("alpha", ["src/alpha/a.ts"]);
		expect(expectedReviewItems(brief, business, "alpha")).toEqual([
			"Criação de subconta",
			"Split sempre presente",
		]);
		expect(expectedReviewItems(brief, business, "general")).toEqual([
			"Criação de subconta",
			"Fluxo beta",
			"Split sempre presente",
		]);
		expect(expectedReviewItems(brief, null, "alpha")).toEqual([]);
	});

	test("checklist ignora acento/caixa e lê variações de veredito", () => {
		const checks = parseReviewChecks({
			checks: [
				{ item: "split SEMPRE presente", verdict: "OK", at: "a.ts:1" },
				{ item: "Outro item", verdict: "gap" },
				"Item sem objeto",
			],
		});
		expect(checks[0]).toMatchObject({ verdict: "ok", at: "a.ts:1" });
		expect(checks[1].verdict).toBe("gap");
		expect(checks[2].verdict).toBe("n/a");
		expect(missingReviewItems(["Split sempre presente"], checks)).toEqual([]);
		expect(missingReviewItems(["Invariante ausente"], checks)).toEqual([
			"Invariante ausente",
		]);
	});

	test("merge de findings preserva a maior severidade e deduplica", () => {
		const suggestion = {
			rule: "Evitar any",
			severity: "suggestion" as const,
			file: "src/alpha/a.ts",
			line: 4,
			message: "any",
			action: "tipar",
		};
		const blocking = { ...suggestion, severity: "blocking" as const };
		expect(mergeFindings([suggestion], [blocking])).toHaveLength(1);
		expect(mergeFindings([suggestion], [blocking])[0].severity).toBe("blocking");
		expect(mergeFindings([suggestion], [suggestion])).toHaveLength(1);
	});

	test("lê as regras numeradas do brief e valida a cobertura", () => {
		const brief = briefWithFiles(
			"alpha",
			["src/alpha/a.ts"],
			["Evitar any.", "Promover: validar a entrada."],
		);
		const rules = briefRules(brief);
		expect(rules).toEqual([
			{ id: 1, severity: "attention", text: "Evitar any." },
			{ id: 2, severity: "attention", text: "Promover: validar a entrada." },
		]);
		const checks = parseRuleChecks({
			rules: [{ id: 1, verdict: "ok", at: "src/alpha/a.ts:1" }, "2: gap"],
		});
		expect(checks).toMatchObject([
			{ id: 1, verdict: "ok" },
			{ id: 2, verdict: "gap" },
		]);
		expect(missingRuleChecks(rules, checks)).toEqual([]);
		// Verdicto sem `at` não é prova: só a regra 1 comprova localização.
		expect(summarizeRuleChecks(rules, checks)).toEqual({
			expected: 2,
			verified: 1,
			missing: 0,
			notApplicable: 0,
			gaps: 1,
		});
	});

	test("checklist dispara por regra não verificada e retoma a sessão", async () => {
		const staging = makeWork(["alpha"]);
		staging.work.writeBrief(
			"alpha",
			briefWithFiles(
				"alpha",
				["src/alpha/a.ts"],
				["Evitar any.", "Evitar console.log."],
			),
		);
		const requests: { prompt: string; resume?: string }[] = [];
		try {
			let calls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async (request) => {
						requests.push({ prompt: request.prompt, resume: request.resume });
						calls++;
						return calls === 1
							? {
									ok: true,
									text: reportJson("alpha"),
									metrics: {
										durationMs: 5,
										sessionId: "sess-1",
										costUsd: 0.01,
									},
									stderr: "",
									exitCode: 0,
								}
							: {
									ok: true,
									text: JSON.stringify({
										watchdogId: "alpha",
										reviewedFiles: ["src/alpha/a.ts"],
										skipped: [],
										rules: [
											{
												id: 1,
												verdict: "ok",
												at: "src/alpha/a.ts:1",
											},
											{
												id: 2,
												verdict: "ok",
												at: "src/alpha/a.ts:2",
											},
										],
										checks: [],
										findings: [],
									}),
									metrics: {
										durationMs: 5,
										sessionId: "sess-1",
										costUsd: 0.005,
									},
									stderr: "",
									exitCode: 0,
								};
					},
				},
			});

			const report = await runner.run(["alpha"]);
			expect(requests).toHaveLength(2);
			expect(requests[1].resume).toBe("sess-1");
			expect(requests[1].prompt).toContain("Regras não verificadas");
			expect(requests[1].prompt).toContain("1, 2");
			expect(report.watchdogs[0].findings).toBe(1);
			expect(report.watchdogs[0].rules).toEqual({
				expected: 2,
				verified: 2,
				missing: 0,
				notApplicable: 0,
				gaps: 0,
			});
			expect(report.watchdogs[0].checklist?.costUsd).toBeCloseTo(0.005);
			expect(report.watchdogs[0].checklist?.numTurns).toBe(0);
		} finally {
			staging.cleanup();
		}
	});

	test("segunda opinião do general roda em sessão nova com os achados já cobertos", async () => {
		const staging = makeWork(["general"]);
		staging.work.writeBrief("general", briefWithFiles("general", ["src/alpha/a.ts"]));
		const requests: { prompt: string; resume?: string }[] = [];
		try {
			let calls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async (request) => {
						requests.push({ prompt: request.prompt, resume: request.resume });
						calls++;
						// 1 = fluxo, 2 = bookkeeping (só vereditos), 3 = adversarial.
						const text =
							calls === 2
								? JSON.stringify({
										watchdogId: "general",
										reviewedFiles: ["src/general/a.ts"],
										skipped: [],
										rules: [],
										checks: [],
										findings: [],
									})
								: reportJson("general", calls === 1 ? 1 : 2);
						return {
							ok: true,
							text,
							metrics: {
								durationMs: 5,
								sessionId: `sess-${calls}`,
								costUsd: 0.02,
								numTurns: 3,
							},
							stderr: "",
							exitCode: 0,
						};
					},
				},
			});

			const report = await runner.run(["general"]);
			expect(requests).toHaveLength(3);
			// Passada base: fluxo puro, sem bookkeeping no schema.
			expect(requests[0].prompt).toContain("Seu produto é **achado**");
			expect(requests[0].prompt).not.toContain('"checks"');
			// Bookkeeping: sessão nova, tarefa estreita.
			expect(requests[1].prompt).toContain("verificador de checklist");
			expect(requests[1].resume).toBeUndefined();
			// Adversarial: sessão nova, com os achados já cobertos.
			expect(requests[2].prompt).toContain("Classes a atacar");
			expect(requests[2].prompt).toContain("Já cobertos");
			expect(requests[2].resume).toBeUndefined();
			expect(report.watchdogs[0].findings).toBe(2);
			expect(report.watchdogs[0].secondOpinion).toMatchObject({
				status: "done",
				findings: 1,
			});
			expect(report.watchdogs[0].secondOpinion?.costUsd).toBeCloseTo(0.02);
			expect(report.watchdogs[0].secondOpinion?.numTurns).toBe(3);
		} finally {
			staging.cleanup();
		}
	});

	test("prompt adversarial em sessão nova cita as cinco classes e não pede bookkeeping", () => {
		const prompt = renderAdversarialPrompt({
			projectName: "Proj",
			watchdogId: "general",
			brief: "# Brief general",
			candidates: [
				{
					rule: "Evitar any",
					severity: "attention",
					file: "a.ts",
					line: 1,
					message: "m",
				},
			],
		});
		for (const term of [
			"Credencial e contexto compartilhado",
			"Capacidade anunciada",
			"Identificador persistido",
			"Idempotência e transição de estado",
			"Contrato entre lados",
		]) {
			expect(prompt).toContain(term);
		}
		expect(prompt).toContain("sessão nova");
		expect(prompt).toContain("Já cobertos");
		expect(prompt).not.toContain('"checks"');
		// Não pode herdar o pedido de "relatório completo" da passada em sessão.
		expect(prompt).not.toContain("findings anteriores + novos");
	});

	test("prompt de bookkeeping pede só vereditos com `at`", () => {
		const prompt = renderBookkeepingPrompt({
			projectName: "Proj",
			watchdogId: "general",
			brief: "# Brief general",
			items: ["Criação de subconta"],
			ruleIds: [1],
		});
		expect(prompt).toContain("- Criação de subconta");
		expect(prompt).toContain('"findings"');
		expect(prompt).toContain("`findings` deve ser sempre `[]`");
	});

	test("rule vazio é inferido com o prefixo do basis", () => {
		const report = withInferredRule({
			watchdogId: "alpha",
			reviewedFiles: [],
			skipped: [],
			findings: [
				{
					rule: "",
					severity: "attention",
					file: "src/alpha/a.ts",
					line: 1,
					message: "Split ausente na criação. Detalhe adicional.",
					action: "enviar split",
					basis: "domain",
				},
				{
					rule: "  ",
					severity: "attention",
					file: "src/alpha/a.ts",
					line: 2,
					message: "Outro problema",
					action: "corrigir",
				},
			],
		});
		expect(report.findings[0].rule).toBe("Domínio: Split ausente na criação");
		expect(report.findings[1].rule).toBe("Lógica: Outro problema");
	});

	test("retry de conteúdo retoma a sessão e envia só o sufixo", async () => {
		const staging = makeWork(["alpha"]);
		try {
			const requests: { prompt: string; resume?: string }[] = [];
			let calls = 0;
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 1,
				runner: {
					run: async (request) => {
						requests.push({ prompt: request.prompt, resume: request.resume });
						calls++;
						return calls === 1
							? {
									ok: true,
									text: "narração sem JSON",
									metrics: { durationMs: 5, sessionId: "sess-1" },
									stderr: "",
									exitCode: 0,
								}
							: {
									ok: true,
									text: reportJson("alpha"),
									metrics: { durationMs: 5, sessionId: "sess-1" },
									stderr: "",
									exitCode: 0,
								};
					},
				},
			});

			const report = await runner.run(["alpha"]);
			expect(report.watchdogs[0].status).toBe("done");
			expect(requests[1].resume).toBe("sess-1");
			expect(requests[1].prompt).toContain("sessão retomada");
			expect(requests[1].prompt).not.toContain("brief de alpha");
		} finally {
			staging.cleanup();
		}
	});

	test("modelo de intenção mais fraco não substitui o da IA", () => {
		const weak = {
			...business,
			source: "reviewer" as const,
			flows: [],
			invariants: ["Split sempre presente"],
		};
		expect(businessScore(weak)).toBeLessThan(businessScore(business));
		const kept = chooseBusinessSummary(business, weak);
		expect(kept.accepted).toBe(false);
		expect(kept.summary).toBe(business);

		const deterministic = { ...business, source: "deterministic" as const };
		expect(chooseBusinessSummary(deterministic, weak).accepted).toBe(true);
		expect(chooseBusinessSummary(null, weak).accepted).toBe(true);
	});

	test("runner repete o brief para cobrir itens não verificados e une achados", async () => {
		const staging = makeWork(["alpha"]);
		staging.work.writeBrief("alpha", briefWithFiles("alpha", ["src/alpha/a.ts"]));
		staging.work.writeBusinessSummary(business);
		const prompts: string[] = [];
		try {
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async (request) => {
						prompts.push(request.prompt);
						if (prompts.length === 1) {
							return {
								ok: true,
								text: reportJson("alpha"),
								metrics: { durationMs: 5 },
								stderr: "",
								exitCode: 0,
							};
						}
						return {
							ok: true,
							text: JSON.stringify({
								watchdogId: "alpha",
								reviewedFiles: ["src/alpha/a.ts"],
								skipped: [],
								checks: [
									{
										item: "Criação de subconta",
										verdict: "ok",
										at: "src/alpha/a.ts:1",
									},
									{
										item: "Split sempre presente",
										verdict: "gap",
										at: "src/alpha/a.ts:2",
									},
								],
								findings: [
									{
										rule: "Evitar any",
										severity: "attention",
										file: "src/alpha/a.ts",
										line: 2,
										message: "split ausente",
										action: "enviar split",
									},
								],
							}),
							metrics: { durationMs: 5 },
							stderr: "",
							exitCode: 0,
						};
					},
				},
			});

			const report = await runner.run(["alpha"]);
			expect(prompts).toHaveLength(2);
			expect(prompts[1]).toContain("Verificação obrigatória (checklist)");
			expect(prompts[1]).toContain("Criação de subconta");
			expect(report.watchdogs[0].findings).toBe(2);
			expect(report.watchdogs[0].checks).toEqual({
				expected: 2,
				verified: 2,
				missing: 0,
				notApplicable: 0,
				gaps: 1,
			});
		} finally {
			staging.cleanup();
		}
	});

	test("businessSummary do general só substitui um modelo mais fraco", async () => {
		const staging = makeWork(["general"]);
		staging.work.writeBrief("general", briefWithFiles("general", ["src/alpha/a.ts"]));
		staging.work.writeBusinessSummary(business);
		try {
			const runner = new HuntRunner({
				work: staging.work,
				root: staging.root,
				projectName: "Proj",
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				concurrency: 1,
				timeoutMs: 10_000,
				retries: 0,
				runner: {
					run: async () => ({
						ok: true,
						text: JSON.stringify({
							watchdogId: "general",
							reviewedFiles: ["src/alpha/a.ts"],
							skipped: [],
							checks: [
								{
									item: "Criação de subconta",
									verdict: "ok",
									at: "src/alpha/a.ts:1",
								},
								{ item: "Fluxo beta", verdict: "n/a" },
								{
									item: "Split sempre presente",
									verdict: "ok",
									at: "src/alpha/a.ts:3",
								},
							],
							findings: [],
							businessSummary: {
								invariants: ["Split sempre presente"],
								flows: [],
								contracts: [],
								states: [],
							},
						}),
						metrics: { durationMs: 5 },
						stderr: "",
						exitCode: 0,
					}),
				},
			});

			const report = await runner.run(["general"]);
			expect(report.watchdogs[0].business).toMatchObject({
				accepted: false,
				source: "ai",
			});
			expect(report.business).toBe("ai");
			const summary = staging.work.readBusinessSummary();
			expect(summary?.source).toBe("ai");
			expect(summary?.flows).toHaveLength(2);
			// `n/a` é veredito, não prova: 2 itens comprovados + 1 não aplicável.
			expect(report.watchdogs[0].checks).toEqual({
				expected: 3,
				verified: 2,
				missing: 0,
				notApplicable: 1,
				gaps: 0,
			});
		} finally {
			staging.cleanup();
		}
	});
});

describe("SpawnMakiRunner (POSIX)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test.skipIf(process.platform === "win32")(
		"lê o JSON do stdout e respeita o timeout",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "houndsman-maki-bin-"));
			dirs.push(dir);
			const binary = join(dir, "maki");
			writeFileSync(
				binary,
				[
					"#!/bin/sh",
					"cat > /dev/null",
					`printf '%s\\n' '{"type":"result","result":"{\\"findings\\":[]}","session_id":"s1","total_cost_usd":0.01,"usage":{"total_tokens":10}}'`,
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const runner = new SpawnMakiRunner(binary);
			const result = await runner.run({
				prompt: "brief",
				cwd: dir,
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				timeoutMs: 5_000,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.text).toContain('"findings"');
				expect(result.metrics.sessionId).toBe("s1");
				expect(result.metrics.costUsd).toBe(0.01);
			}

			const slow = join(dir, "maki-slow");
			writeFileSync(slow, "#!/bin/sh\nsleep 10\n");
			chmodSync(slow, 0o755);
			const timedOut = await new SpawnMakiRunner(slow).run({
				prompt: "brief",
				cwd: dir,
				model: "deepseek/deepseek-v4-pro",
				apiKeyEnv: "DEEPSEEK_API_KEY",
				apiKey: "sk",
				timeoutMs: 100,
			});
			expect(timedOut.ok).toBe(false);
			if (!timedOut.ok) expect(timedOut.timedOut).toBe(true);
		},
	);
});
