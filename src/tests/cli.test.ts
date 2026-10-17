/**
 * Smoke test do CLI (`src/cli/index.ts`).
 *
 * O `main()` carrega cada comando por **import dinâmico** — este teste invoca o
 * CLI como processo (num projeto mínimo em disco) para garantir que os caminhos
 * lazy resolvem em runtime. É a única cobertura end-to-end do binário.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Caminho do executável do CLI (TS, rodado pelo Bun). */
const CLI = join(import.meta.dir, "..", "cli", "index.ts");

/** Config mínima, como objeto literal (o `loadConfig` deriva `watchdogIds`). */
const CONFIG = `export default {
	projectName: "Smoke",
	watchdogs: {
		alpha: {
			id: "alpha",
			name: "Alpha",
			description: "Watchdog de smoke.",
			scope: "src/**",
			classify: [{ value: "^src/" }],
			rules: [{ severity: "attention", text: "Evitar any." }],
			contextFiles: [],
		},
	},
	exclusions: [],
	docMappings: [],
};
`;

type Project = { cwd: string; artifacts: string; cleanup: () => void };

/** Projeto temporário: config + uma run com um finding. */
function makeProject(): Project {
	const cwd = mkdtempSync(join(tmpdir(), "houndsman-cli-"));
	const artifacts = join(cwd, ".houndsman", ".runs");
	const runDir = join(artifacts, "main");
	mkdirSync(join(runDir, "findings"), { recursive: true });
	writeFileSync(join(cwd, "houndsman.config.ts"), CONFIG);
	writeFileSync(
		join(runDir, "classification.json"),
		JSON.stringify({ watchdogs: { alpha: ["src/a.ts"] } }),
	);
	writeFileSync(
		join(runDir, "findings", "alpha.json"),
		JSON.stringify({
			watchdogId: "alpha",
			reviewedFiles: ["src/a.ts"],
			skipped: [],
			findings: [
				{
					rule: "Evitar any",
					severity: "attention",
					file: "src/a.ts",
					line: 1,
					message: "any detectado",
					action: "tipar",
				},
			],
		}),
	);
	return {
		cwd,
		artifacts,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

type CliResult = { code: number; stdout: string; stderr: string };

/** Invoca o CLI como processo, no cwd informado. */
function runCli(cwd: string, args: string[]): CliResult {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

describe("cli smoke — imports dinâmicos", () => {
	test("help imprime o uso (sem carregar config)", () => {
		const result = runCli(process.cwd(), ["help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Uso: houndsman");
	});

	test("watchdog <id> devolve o contexto (import lazy de commands/watchdog)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["watchdog", "alpha", "--json"]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).id).toBe("alpha");
		} finally {
			project.cleanup();
		}
	});

	test("findings summary devolve a triagem (import lazy de commands/findings)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, [
				"findings",
				"summary",
				"--json",
				"--dir",
				project.artifacts,
				"--branch",
				"main",
			]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).total).toBe(1);
		} finally {
			project.cleanup();
		}
	});

	test("doctor valida a config (import lazy de registry-check)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["doctor"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Validando");
		} finally {
			project.cleanup();
		}
	});

	test("context é fail-open sem PR (import lazy de commands/context)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["context", "--branch", "main"]);
			expect(result.code).toBe(0);
		} finally {
			project.cleanup();
		}
	});
});
