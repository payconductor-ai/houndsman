import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFindingsCommand, runVerifyCommand } from "../core/commands/findings";
import { buildStateFromFindings, fileReader } from "../core/findings-state";
import {
	dedupeFindings,
	parseWatchdogReport,
	type WatchdogReport,
} from "../core/report-builder";
import { buildRepoIdentity } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import type { RepoIdentity } from "../core/storage/types";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

/** Ambiente temporário: banco + review semeada com os findings informados. */
type Env = {
	storage: SQLiteStorageProvider;
	repo: RepoIdentity;
	reviewId: string;
	dir: string;
	cleanup: () => void;
};

let activeEnv: Env | null = null;

function makeRun(reports: WatchdogReport[], branch = "main"): Env {
	const dir = mkdtempSync(join(tmpdir(), "houndsman-findings-"));
	const storage = new SQLiteStorageProvider(join(dir, "houndsman.db"));
	const repo = buildRepoIdentity(null, dir);
	const review = storage.getOrCreateReview({ repo, branch, slug: branch });
	const state = buildStateFromFindings(dedupeFindings(reports), {
		branch,
		readFile: fileReader(process.cwd()),
	});
	storage.writeFindings(review.id, state);
	const env: Env = {
		storage,
		repo,
		reviewId: review.id,
		dir,
		cleanup: () => {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	activeEnv = env;
	return env;
}

function reportOf(
	watchdogId: string,
	findings: unknown[],
	files: string[],
): WatchdogReport {
	const report = parseWatchdogReport(
		{ watchdogId, reviewedFiles: files, skipped: [], findings },
		`${watchdogId}.json`,
	);
	if (!report) throw new Error("relatório de teste inválido");
	return report;
}

const ONE_FINDING = [
	reportOf(
		"alpha",
		[
			{
				rule: "Nunca usar any",
				severity: "blocking",
				file: "src/alpha/f.ts",
				line: 2,
				message: "any detectado",
				action: "tipar",
			},
		],
		["src/alpha/f.ts"],
	),
];

/** Remove `--dir` (flag extinta) dos args legados usados nos testes. */
function stripDir(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--dir") {
			i++;
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

/** Executa o comando contra o ambiente ativo. */
function run(args: string[]) {
	if (!activeEnv) throw new Error("makeRun não foi chamado");
	return runFindingsCommand(
		fakeHoundsmanConfig,
		activeEnv.storage,
		activeEnv.repo,
		stripDir(args),
	);
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
			const emptyStorage = new SQLiteStorageProvider(join(empty, "db.sqlite"));
			try {
				const absent = runFindingsCommand(
					fakeHoundsmanConfig,
					emptyStorage,
					buildRepoIdentity(null, empty),
					["list", "--branch", "main"],
				);
				expect(absent.exitCode).toBe(1);
				expect(absent.output).toContain("--finalize");
			} finally {
				emptyStorage.close();
				rmSync(empty, { recursive: true, force: true });
			}
		} finally {
			run0.cleanup();
		}
	});

	test("path devolve a referência do storage", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			run(["list", "--dir", run0.dir, "--branch", "main"]);
			const result = run(["path", "--dir", run0.dir, "--branch", "main"]);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("sqlite:");
			expect(result.output).toContain(run0.reviewId);
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
		const env = makeRun([
			reportOf(
				"alpha",
				[
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
				["src/a.ts"],
			),
			reportOf(
				"beta",
				[
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
				["src/b.ts"],
			),
		]);
		try {
			const list = JSON.parse(run(["list", "--branch", "main", "--json"]).output);
			for (const item of list) {
				run(["set", item.id, "--decision", "execute", "--branch", "main"]);
			}

			const result = run(["batch", "--branch", "main", "--json"]);
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

			const markdown = run(["batch", "--branch", "main"]);
			expect(markdown.output).toContain("Grupo atual");
			expect(markdown.output).toContain("Outros grupos");

			const scoped = run([
				"batch",
				"--group",
				"file:src/b.ts",
				"--branch",
				"main",
				"--json",
			]);
			expect(JSON.parse(scoped.output).current.key).toBe("file:src/b.ts");
		} finally {
			env.cleanup();
		}
	});

	test("mutações fazem ping no status da review", () => {
		const run0 = makeRun(ONE_FINDING);
		try {
			const id = JSON.parse(
				run(["list", "--dir", run0.dir, "--branch", "main", "--json"]).output,
			)[0].id;
			const status = () => run0.storage.getReview(run0.reviewId)?.status;

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
			expect(status()).toBe("review_done");

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
			expect(status()).toBe("fixing");

			run(["done", id, "--dir", run0.dir, "--branch", "main"]);
			expect(status()).toBe("fix_done");
		} finally {
			run0.cleanup();
		}
	});
});

describe("findings verify", () => {
	const FILE = "src/tests/fixtures/fake-project.ts";

	/** Run fake apontando para um arquivo real (relativo ao cwd → âncora resolvível). */
	function makeVerifyRun(): Env {
		return makeRun(
			[
				reportOf(
					"alpha",
					[
						{
							rule: "regra",
							severity: "attention",
							file: FILE,
							line: 1,
							message: "msg",
							action: "ação",
						},
					],
					[FILE],
				),
			],
			"main",
		);
	}

	test("reporta persisting e grava o verify.md (tier local)", async () => {
		const run0 = makeVerifyRun();
		try {
			const result = await runVerifyCommand(
				fakeHoundsmanConfig,
				run0.storage,
				run0.repo,
				["verify", "--branch", "main", "--json"],
			);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.output);
			expect(parsed.summary.persisting).toBe(1);
			expect(parsed.entries[0].basis).toBe("anchor");
			expect(
				run0.storage.readArtifact(run0.reviewId, "verify.md")?.content,
			).toContain("# Verificação");
		} finally {
			run0.cleanup();
		}
	});

	test("sem --apply não altera o estado", async () => {
		const run0 = makeVerifyRun();
		try {
			await runVerifyCommand(fakeHoundsmanConfig, run0.storage, run0.repo, [
				"verify",
				"--branch",
				"main",
			]);
			const state = run0.storage.readFindings(run0.reviewId);
			const only = Object.values(state?.findings ?? {})[0];
			expect(only.execState).toBe("pending");
		} finally {
			run0.cleanup();
		}
	});
});
