import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFindingsCommand, runVerifyCommand } from "../core/commands/findings";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

/** Run fake em disco: classification.json + findings/alpha.json. */
function makeRun(findings: unknown[]): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "houndsman-findings-"));
	const outDir = join(dir, "main");
	mkdirSync(join(outDir, "findings"), { recursive: true });
	writeFileSync(
		join(outDir, "classification.json"),
		JSON.stringify({ watchdogs: { alpha: ["src/alpha/f.ts"] } }),
	);
	writeFileSync(
		join(outDir, "findings", "alpha.json"),
		JSON.stringify({
			watchdogId: "alpha",
			reviewedFiles: ["src/alpha/f.ts"],
			skipped: [],
			findings,
		}),
	);
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ONE_FINDING = [
	{
		rule: "Nunca usar any",
		severity: "blocking",
		file: "src/alpha/f.ts",
		line: 2,
		message: "any detectado",
		action: "tipar",
	},
];

function run(args: string[]) {
	return runFindingsCommand(fakeHoundsmanConfig, args);
}

describe("findings command", () => {
	test("list reconstrói o estado a partir dos artefatos", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const result = run(["list", "--dir", run0.dir, "--branch", "main", "--json"]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].decision).toBe("pending");
			expect(parsed[0].id).toBeTruthy();
			expect(parsed[0].severity).toBe("blocking");
		} finally {
			run0.cleanup();
		}
	});

	test("set atualiza decisão + comentário e persiste", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const list = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			);
			const id = list[0].id;

			const set = run([
				"set",
				id,
				"--decision",
				"execute",
				"--comment",
				"trocar por unknown",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			expect(set.exitCode).toBe(0);

			const after = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			);
			expect(after[0].decision).toBe("execute");
			expect(after[0].comment).toBe("trocar por unknown");
			expect(after[0].history.length).toBeGreaterThan(0);
		} finally {
			run0.cleanup();
		}
	});

	test("done marca execState como done", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const id = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			)[0].id;
			expect(
				run(["done", id, "--dir", run0.dir, "--branch", "main"]).exitCode,
			).toBe(0);
			const after = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			);
			expect(after[0].execState).toBe("done");
		} finally {
			run0.cleanup();
		}
	});

	test("filtra por decisão e resume contagens", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const id = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			)[0].id;
			run([
				"set",
				id,
				"--decision",
				"ignore",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);

			const pending = JSON.parse(
				run([
					"list",
					"--decision",
					"pending",
					"--dir",
					run0.dir,
					"--branch",
					"main",
					"--json",
				]).output,
			);
			expect(pending).toHaveLength(0);

			const summary = JSON.parse(
				run(["summary", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			);
			expect(summary.total).toBe(1);
			expect(summary.byDecision.ignore).toBe(1);
		} finally {
			run0.cleanup();
		}
	});

	test("sync marca como stale quando o arquivo não está disponível", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const result = JSON.parse(
				run(["sync", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			);
			expect(result.stale).toHaveLength(1);
		} finally {
			run0.cleanup();
		}
	});

	test("erros claros: decisão inválida, id inexistente, run ausente", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const bad = run([
				"set",
				"inexistente",
				"--decision",
				"xpto",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			expect(bad.exitCode).toBe(1);
			expect(bad.output).toContain("--decision inválido");

			const missing = run([
				"show",
				"nao-existe",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			expect(missing.exitCode).toBe(1);
			expect(missing.output).toContain("não encontrado");

			const empty = mkdtempSync(join(tmpdir(), "houndsman-empty-"));
			try {
				const absent = run(["list", "--dir", empty, "--branch", "main"]);
				expect(absent.exitCode).toBe(1);
				expect(absent.output).toContain("--finalize");
			} finally {
				rmSync(empty, { recursive: true, force: true });
			}
		} finally {
			run0.cleanup();
		}
	});

	test("path devolve o caminho do state.json", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			run(["list", "--dir", run0.dir, "--branch", "main"]);
			const result = run(["path", "--dir", run0.dir, "--branch", "main"]);
			expect(result.exitCode).toBe(0);
			expect(result.output.replace(/\\/g, "/")).toContain("main/state.json");
		} finally {
			run0.cleanup();
		}
	});

	test("sub desconhecido devolve erro", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const result = run(["xpto", "--dir", run0.dir, "--branch", "main"]);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("desconhecido");
		} finally {
			run0.cleanup();
		}
	});

	test("batch agrupa a fila e devolve o grupo atual + outros grupos", () => {
		const dir = mkdtempSync(join(tmpdir(), "houndsman-batch-"));
		const outDir = join(dir, "main");
		mkdirSync(join(outDir, "findings"), { recursive: true });
		writeFileSync(
			join(outDir, "classification.json"),
			JSON.stringify({ watchdogs: { alpha: ["src/a.ts"], beta: ["src/b.ts"] } }),
		);
		writeFileSync(
			join(outDir, "findings", "alpha.json"),
			JSON.stringify({
				watchdogId: "alpha",
				reviewedFiles: ["src/a.ts"],
				skipped: [],
				findings: [
					{
						rule: "R1",
						severity: "blocking",
						file: "src/a.ts",
						line: 1,
						message: "m1",
						action: "a",
					},
					{
						rule: "R2",
						severity: "attention",
						file: "src/a.ts",
						line: 2,
						message: "m2",
						action: "a",
					},
					{
						rule: "R3",
						severity: "attention",
						file: "src/a.ts",
						line: 3,
						message: "m3",
						action: "a",
					},
					{
						rule: "R4",
						severity: "nit",
						file: "src/a.ts",
						line: 4,
						message: "m4",
						action: "a",
					},
				],
			}),
		);
		writeFileSync(
			join(outDir, "findings", "beta.json"),
			JSON.stringify({
				watchdogId: "beta",
				reviewedFiles: ["src/b.ts"],
				skipped: [],
				findings: [
					{
						rule: "R5",
						severity: "attention",
						file: "src/b.ts",
						line: 1,
						message: "m5",
						action: "a",
					},
					{
						rule: "R6",
						severity: "suggestion",
						file: "src/b.ts",
						line: 2,
						message: "m6",
						action: "a",
					},
				],
			}),
		);
		try {
			const list = JSON.parse(
				run(["list", "--dir", dir, "--branch", "main", "--json"]).output,
			);
			for (const item of list) {
				run([
					"set",
					item.id,
					"--decision",
					"execute",
					"--dir",
					dir,
					"--branch",
					"main",
				]);
			}

			const result = run(["batch", "--dir", dir, "--branch", "main", "--json"]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output);
			expect(parsed.dimension).toBe("file");
			expect(parsed.totals.queue).toBe(6);
			expect(parsed.totals.groups).toBe(2);
			expect(parsed.current.key).toBe("file:src/a.ts");
			expect(parsed.current.findings).toHaveLength(4);
			expect(parsed.others).toEqual([
				expect.objectContaining({ key: "file:src/b.ts", count: 2 }),
			]);

			const markdown = run(["batch", "--dir", dir, "--branch", "main"]);
			expect(markdown.output).toContain("Grupo atual");
			expect(markdown.output).toContain("Outros grupos");

			const scoped = run([
				"batch",
				"--group",
				"file:src/b.ts",
				"--dir",
				dir,
				"--branch",
				"main",
				"--json",
			]);
			expect(JSON.parse(scoped.output).current.key).toBe("file:src/b.ts");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("mutações fazem ping no run.json (status)", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const id = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			)[0].id;
			const runJson = join(run0.dir, "main", "run.json");

			run([
				"set",
				id,
				"--decision",
				"execute",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			expect(JSON.parse(readFileSync(runJson, "utf8")).status).toBe("review_done");

			run([
				"set",
				id,
				"--exec",
				"in_progress",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			expect(JSON.parse(readFileSync(runJson, "utf8")).status).toBe("fixing");

			run(["done", id, "--dir", run0.dir, "--branch", "main"]);
			expect(JSON.parse(readFileSync(runJson, "utf8")).status).toBe("fix_done");
		} finally {
			run0.cleanup();
		}
	});
});

describe("findings verify", () => {
	const FILE = "src/tests/fixtures/fake-project.ts";

	/** Run fake apontando para um arquivo real (relativo ao cwd → âncora resolvível). */
	function makeVerifyRun(): { dir: string; outDir: string; cleanup: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "houndsman-verify-"));
		const outDir = join(dir, "main");
		mkdirSync(join(outDir, "findings"), { recursive: true });
		writeFileSync(
			join(outDir, "classification.json"),
			JSON.stringify({ watchdogs: { alpha: [FILE] } }),
		);
		writeFileSync(
			join(outDir, "findings", "alpha.json"),
			JSON.stringify({
				watchdogId: "alpha",
				reviewedFiles: [FILE],
				skipped: [],
				findings: [
					{
						rule: "regra",
						severity: "attention",
						file: FILE,
						line: 1,
						message: "msg",
						action: "ação",
					},
				],
			}),
		);
		return {
			dir,
			outDir,
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	}

	test("reporta persisting e grava o verify.md (tier local)", async () => {
		const run0 = makeVerifyRun();
		try {
			const result = await runVerifyCommand(fakeHoundsmanConfig, [
				"verify",
				"--dir",
				run0.dir,
				"--branch",
				"main",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output);
			expect(parsed.summary.persisting).toBe(1);
			expect(parsed.entries[0].basis).toBe("anchor");
			expect(existsSync(join(run0.outDir, "verify.md"))).toBe(true);
		} finally {
			run0.cleanup();
		}
	});

	test("sem --apply não altera o estado", async () => {
		const run0 = makeVerifyRun();
		try {
			await runVerifyCommand(fakeHoundsmanConfig, [
				"verify",
				"--dir",
				run0.dir,
				"--branch",
				"main",
			]);
			const state = JSON.parse(
				readFileSync(join(run0.outDir, "state.json"), "utf8"),
			) as { findings: Record<string, { execState: string }> };
			const only = Object.values(state.findings)[0];
			expect(only.execState).toBe("pending");
		} finally {
			run0.cleanup();
		}
	});
});
