/**
 * `hunt` — parser de flags, dry-run e fluxo completo com provider fake.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineHoundsmanConfig } from "../core/config";
import { HoundsmanEngine } from "../core/engine/houndsman-engine";
import { SilentLogger } from "../core/logging";
import { defineWatchdog } from "../core/types";
import { HuntHarness } from "../harness/hunt/hunt-harness";
import { parseHuntArgs } from "../harness/hunt/hunt-options";
import { FakeModelProvider } from "./fixtures/fake-model-provider";

const RULE = "Nunca usar `any`.";

const configBase = defineHoundsmanConfig({
	projectName: "Hunt",
	watchdogs: {
		alpha: defineWatchdog({
			id: "alpha",
			name: "Alpha",
			description: "Watchdog do hunt.",
			scope: "src/alpha/**",
			classify: [{ value: "^src/alpha/" }],
			rules: [{ severity: "blocking", text: RULE }],
			contextFiles: [],
		}),
	},
	exclusions: [],
	docMappings: [],
});

describe("parseHuntArgs", () => {
	test("flags e defaults", () => {
		const options = parseHuntArgs([
			"--base",
			"origin/main",
			"--head",
			"abc",
			"--watchdog",
			"alpha",
			"--full",
			"--no-ast",
			"--resume",
			"--allow-partial",
			"--dry-run",
			"--fail-on-blocking",
			"--max-calls",
			"7",
			"--concurrency",
			"3",
			"--model",
			"m",
		]);
		expect(options.base).toBe("origin/main");
		expect(options.head).toBe("abc");
		expect(options.watchdog).toBe("alpha");
		expect(options.full).toBe(true);
		expect(options.noAst).toBe(true);
		expect(options.noJev).toBe(true);
		expect(options.resume).toBe(true);
		expect(options.allowPartial).toBe(true);
		expect(options.dryRun).toBe(true);
		expect(options.failOnBlocking).toBe(true);
		expect(options.maxCalls).toBe(7);
		expect(options.concurrency).toBe(3);
		expect(options.model).toBe("m");
	});
});

// ---------------------------------------------------------------------------
// Repo git temporário
// ---------------------------------------------------------------------------

const cwd = mkdtempSync(join(tmpdir(), "houndsman-hunt-"));
const originalCwd = process.cwd();
const originalHome = process.env.HOUNDSMAN_HOME;
const originalKey = process.env.HOUNDSMAN_DEEP_SEEK_API_KEY;
let base = "";

function git(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

function setupRepo(): void {
	git(["init", "-b", "main"]);
	git(["config", "user.email", "hunt@example.test"]);
	git(["config", "user.name", "Hunt"]);
	git(["config", "commit.gpgsign", "false"]);
	mkdirSync(join(cwd, "src", "alpha"), { recursive: true });
	writeFileSync(join(cwd, "src/alpha/a.ts"), "export const a = 1;\n");
	git(["add", "."]);
	git(["commit", "-m", "initial"]);
	base = git(["rev-parse", "HEAD"]).trim();
	writeFileSync(join(cwd, "src/alpha/a.ts"), "export const a: any = 1;\n");
	git(["add", "-A"]);
	git(["commit", "-m", "change"]);
	process.env.HOUNDSMAN_HOME = join(cwd, ".home");
	process.chdir(cwd);
}

function engine(): HoundsmanEngine {
	return new HoundsmanEngine({
		...configBase,
		storage: { provider: "sqlite", path: join(cwd, "houndsman.db") },
	});
}

setupRepo();
afterAll(() => {
	process.chdir(originalCwd);
	if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
	else process.env.HOUNDSMAN_HOME = originalHome;
	if (originalKey === undefined) delete process.env.HOUNDSMAN_DEEP_SEEK_API_KEY;
	else process.env.HOUNDSMAN_DEEP_SEEK_API_KEY = originalKey;
	rmSync(cwd, { recursive: true, force: true });
});

describe("hunt", () => {
	test("dry-run lista watchdogs sem chamar IA", async () => {
		const instance = engine();
		try {
			const harness = await HuntHarness.from(
				instance,
				parseHuntArgs(["--base", base, "--head", "HEAD", "--dry-run"]),
				new SilentLogger(),
			);
			const result = await harness.run();
			expect(result.status).toBe("dry-run");
			expect(result.messages.join("\n")).toContain("alpha");
		} finally {
			instance.close();
		}
	});

	test("sem chave e sem --dry-run falha com mensagem clara", async () => {
		delete process.env.HOUNDSMAN_DEEP_SEEK_API_KEY;
		const instance = engine();
		try {
			await expect(
				HuntHarness.from(
					instance,
					parseHuntArgs(["--base", base, "--head", "HEAD"]),
					new SilentLogger(),
				),
			).rejects.toThrow(/hunt exige IA configurada/);
		} finally {
			instance.close();
		}
	});

	test("provider fake investiga, grava findings e finaliza", async () => {
		const provider = new FakeModelProvider(async (request, index) => {
			if (index === 0) return { hypotheses: ["any"] };
			if (index === 1) return { taskIds: ["rule-0"] };
			const tool = request.tools?.read_file_range;
			if (!tool) throw new Error("read_file_range ausente");
			const parsed = JSON.parse(
				await tool.execute({ path: "src/alpha/a.ts", startLine: 1, endLine: 1 }),
			) as { evidence?: { id: string }[] };
			return {
				findingDrafts: [
					{
						rule: RULE,
						severity: "blocking",
						file: "src/alpha/a.ts",
						line: 1,
						message: "any detectado",
						action: "tipar",
						evidenceIds: [parsed.evidence?.[0]?.id].filter(Boolean),
						confidence: 0.9,
					},
				],
				coverage: [{ rule: RULE, status: "checked" }],
			};
		});
		const instance = engine();
		try {
			const harness = await HuntHarness.from(
				instance,
				parseHuntArgs(["--base", base, "--head", "HEAD"]),
				new SilentLogger(),
				provider,
			);
			const result = await harness.run();
			expect(result.status).toBe("completed");
			expect(result.blockers).toBe(1);
			const review = instance.storage.readArtifact(result.reviewId, "review.md");
			expect(review?.content).toContain("any detectado");
			const transcript = instance.storage.readArtifact(
				result.reviewId,
				"harness-transcript.json",
			);
			expect(transcript?.content).toContain("VERIFY");
			const usage = instance.storage.readArtifact(result.reviewId, "ai-usage.json");
			expect(usage?.content).toContain('"calls"');
		} finally {
			instance.close();
		}
	});
});
