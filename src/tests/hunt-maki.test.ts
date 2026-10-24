/**
 * Harness local — prompt, parser de saída, runner e política de retry.
 *
 * Testa o `core/hunt` sem processo real: o `MakiProcessRunner` é injetado.
 * A execução via `Bun.spawn` é coberta em plataformas POSIX nos testes abaixo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineHoundsmanConfig } from "../core/config";
import { HuntRunner } from "../core/hunt/hunt-runner";
import { requireMakiModel, resolveMakiModel } from "../core/hunt/maki-model";
import { renderHuntPrompt } from "../core/hunt/maki-prompt";
import {
	extractJsonObject,
	MAKI_DISALLOWED_TOOLS,
	makiArgs,
	parseMakiOutput,
	SpawnMakiRunner,
} from "../core/hunt/maki-runner";
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
		]);
		expect(args).not.toContain("--yolo");
		expect(args).not.toContain("--trust");
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
