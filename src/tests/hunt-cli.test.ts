/**
 * Smoke test do comando `hunt` (harness local).
 *
 * Não executa o maki real: cobre help, doctor e os erros acionáveis antes do
 * prepare. A skill `/houndsman hunt` continua coberta pelos testes da camada.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli", "index.ts");

const CONFIG = (hunt = "") => `export default {
	projectName: "Hunt Smoke",
	storage: { provider: "sqlite", path: "./houndsman.db" },
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
	${hunt}
};
`;

type Project = { cwd: string; home: string; cleanup: () => void };

function makeProject(hunt = ""): Project {
	const cwd = mkdtempSync(join(tmpdir(), "houndsman-hunt-cli-"));
	const home = mkdtempSync(join(tmpdir(), "houndsman-hunt-home-"));
	writeFileSync(join(cwd, "houndsman.config.ts"), CONFIG(hunt));
	return {
		cwd,
		home,
		cleanup: () => {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		},
	};
}

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): CliResult {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

describe("hunt — help e diagnóstico", () => {
	test("--help distingue a skill do comando CLI", () => {
		const result = runCli(process.cwd(), ["hunt", "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("/houndsman hunt");
		expect(result.stdout).toContain("houndsman hunt install");
		expect(result.stdout).toContain("--allow-partial");
	});

	test("doctor não falha sem maki e trata o harness como opcional", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["hunt", "doctor"], {
				HOUNDSMAN_HOME: project.home,
				HOUNDSMAN_MAKI_PATH: join(project.cwd, "maki-inexistente"),
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Harness local");
			expect(result.stdout).toContain("modelo:");
			expect(result.stdout).toContain("harness:");
		} finally {
			project.cleanup();
		}
	});

	test("doctor funciona sem projeto configurado (diagnóstico global)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-hunt-nocfg-"));
		const home = mkdtempSync(join(tmpdir(), "houndsman-hunt-home-"));
		try {
			const result = runCli(cwd, ["hunt", "doctor"], {
				HOUNDSMAN_HOME: home,
				HOUNDSMAN_MAKI_PATH: join(cwd, "maki-inexistente"),
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Harness local");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("hunt — erros antes do prepare", () => {
	test("sem binário, orienta a instalar (e não toca na review)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["hunt", "--branch", "main"], {
				HOUNDSMAN_HOME: project.home,
				HOUNDSMAN_MAKI_PATH: join(project.cwd, "maki-inexistente"),
				HOUNDSMAN_DEEP_SEEK_API_KEY: "sk-test",
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("hunt install");
		} finally {
			project.cleanup();
		}
	});

	test("sem credencial, aponta a env correta", () => {
		const project = makeProject();
		try {
			const env = { ...process.env };
			delete env.HOUNDSMAN_DEEP_SEEK_API_KEY;
			const proc = Bun.spawnSync(["bun", CLI, "hunt", "--branch", "main"], {
				cwd: project.cwd,
				env: {
					...env,
					NO_COLOR: "1",
					HOUNDSMAN_HOME: project.home,
					HOUNDSMAN_MAKI_PATH: join(project.cwd, "maki-inexistente"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(proc.exitCode).toBe(1);
			expect(proc.stderr.toString()).toContain("HOUNDSMAN_DEEP_SEEK_API_KEY");
		} finally {
			project.cleanup();
		}
	});

	test("respeita hunt.enabled: false", () => {
		const project = makeProject("hunt: { enabled: false },");
		try {
			const result = runCli(project.cwd, ["hunt"], {
				HOUNDSMAN_HOME: project.home,
				HOUNDSMAN_DEEP_SEEK_API_KEY: "sk-test",
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("desligado");
		} finally {
			project.cleanup();
		}
	});

	test("rejeita --finalize (o hunt já finaliza)", () => {
		const project = makeProject();
		try {
			const result = runCli(project.cwd, ["hunt", "--finalize"], {
				HOUNDSMAN_HOME: project.home,
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("já finaliza");
		} finally {
			project.cleanup();
		}
	});

	test("subcomando desconhecido mostra o help", () => {
		const result = runCli(process.cwd(), ["hunt", "foo"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("desconhecido");
		expect(result.stdout).toContain("houndsman hunt install");
	});
});
