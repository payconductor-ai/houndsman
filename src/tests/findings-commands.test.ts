import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFindingsCommand } from "../core/commands/findings";
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
});
