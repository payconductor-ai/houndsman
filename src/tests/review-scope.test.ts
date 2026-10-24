/**
 * Escopo do review: completo × incremental × no-op.
 *
 * Congela a decisão que evita re-revisar a PR inteira: mesmo commit revisado
 * vira no-op (sem `--full`/`--clean`), delta vira incremental com carry-over.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstService } from "../core/ast/service";
import { ReviewScopeResolver, type ScopeOptions } from "../core/engine/review-scope";
import type { FindingState, FindingsStateFile } from "../core/findings-state";
import type { PrepareProgressEvent } from "../core/orchestrator";
import { defaultOptions, finalize, prepare, reviewContext } from "../core/orchestrator";
import { resolveRepoIdentity } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findingState(overrides: Partial<FindingState> = {}): FindingState {
	return {
		id: "abcdef1234",
		fingerprint: "0123456789abcdef",
		watchdogIds: ["alpha"],
		rule: "regra",
		severity: "blocking",
		file: "src/alpha/keep.ts",
		line: 1,
		message: "mensagem",
		action: "ação",
		anchor: null,
		count: 1,
		present: true,
		decision: "pending",
		execState: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		history: [],
		...overrides,
	};
}

function stateWith(
	reviewedSha: string,
	findings: Record<string, FindingState> = {},
): FindingsStateFile {
	return {
		version: 2,
		branch: "main",
		slug: "main",
		updatedAt: "2026-01-01T00:00:00.000Z",
		order: Object.keys(findings),
		reviewed: { headSha: reviewedSha, at: "2026-01-01T00:00:00.000Z" },
		findings,
	};
}

function options(overrides: Partial<ScopeOptions> = {}): ScopeOptions {
	return { base: "main", head: "HEAD", full: false, clean: false, ...overrides };
}

function git(cwd: string, args: string[]): string {
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

type Repo = { cwd: string; base: string; head: string; cleanup: () => void };

/** Repositório temporário: `base` → `head` altera `src/alpha/a.ts`. */
function makeRepo(): Repo {
	const cwd = mkdtempSync(join(tmpdir(), "houndsman-scope-"));
	git(cwd, ["init", "-b", "main"]);
	git(cwd, ["config", "user.email", "scope@example.test"]);
	git(cwd, ["config", "user.name", "Scope"]);
	git(cwd, ["config", "commit.gpgsign", "false"]);
	git(cwd, ["config", "tag.gpgsign", "false"]);

	mkdirSync(join(cwd, "src", "alpha"), { recursive: true });
	writeFileSync(join(cwd, "src", "alpha", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(cwd, "src", "alpha", "keep.ts"), "export const keep = 1;\n");
	writeFileSync(join(cwd, "README.md"), "# Fake\n");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "initial"]);
	const base = git(cwd, ["rev-parse", "HEAD"]).trim();

	writeFileSync(join(cwd, "src", "alpha", "a.ts"), "export const a = 2;\n");
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-m", "change"]);
	const head = git(cwd, ["rev-parse", "HEAD"]).trim();

	return {
		cwd,
		base,
		head,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

// ---------------------------------------------------------------------------
// Decisão de escopo
// ---------------------------------------------------------------------------

describe("ReviewScopeResolver", () => {
	test("mesmo commit revisado vira no-op (sem tocar no git)", async () => {
		const sha = "a".repeat(40);
		const scope = await new ReviewScopeResolver(
			options(),
			fakeHoundsmanConfig,
		).resolve(stateWith(sha), sha);

		expect(scope.kind).toBe("noop");
		if (scope.kind !== "noop") throw new Error("esperava noop");
		expect(scope.reviewedFrom).toBe(sha);
		expect(scope.headSha).toBe(sha);
	});

	test("`--full` re-revisa o mesmo commit", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		try {
			process.chdir(repo.cwd);
			const scope = await new ReviewScopeResolver(
				options({ base: repo.base, full: true }),
				fakeHoundsmanConfig,
			).resolve(stateWith(repo.head), repo.head);

			expect(scope.kind).toBe("review");
			if (scope.kind !== "review") throw new Error("esperava review");
			expect(scope.classification.mode).toBe("full");
			expect(scope.classification.headSha).toBe(repo.head);
			expect(scope.classification.changedScope?.["src/alpha/a.ts"]).toEqual({
				ranges: [{ start: 1, end: 1 }],
				symbols: [],
				source: "hunks",
			});
		} finally {
			process.chdir(originalCwd);
			repo.cleanup();
		}
	});

	test("escopo usa o símbolo AST quando disponível", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		try {
			process.chdir(repo.cwd);
			const ast = new AstService(fakeHoundsmanConfig);
			const scope = await new ReviewScopeResolver(
				options({ base: repo.base, full: true }),
				fakeHoundsmanConfig,
				ast,
			).resolve(null, repo.head);

			expect(scope.kind).toBe("review");
			if (scope.kind !== "review") throw new Error("esperava review");
			const file = scope.classification.changedScope?.["src/alpha/a.ts"];
			expect(file?.source).toBe("ast");
			expect(file?.symbols.map((symbol) => symbol.name)).toEqual(["a"]);
			expect(file?.ranges).toEqual([{ start: 1, end: 1 }]);
		} finally {
			process.chdir(originalCwd);
			repo.cleanup();
		}
	});

	test("delta revisa só os arquivos alterados e carrega o resto", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		try {
			process.chdir(repo.cwd);
			const previous = stateWith(repo.base, {
				abcdef1234: findingState({ file: "src/alpha/keep.ts" }),
				fedcba4321: findingState({ file: "src/alpha/a.ts" }),
			});
			const scope = await new ReviewScopeResolver(
				options({ base: repo.base }),
				fakeHoundsmanConfig,
			).resolve(previous, repo.head);

			expect(scope.kind).toBe("review");
			if (scope.kind !== "review") throw new Error("esperava review");
			expect(scope.classification.mode).toBe("incremental");
			expect(scope.classification.reviewedFrom).toBe(repo.base);
			expect(Object.keys(scope.classification.files)).toEqual(["src/alpha/a.ts"]);
			expect(scope.classification.changedScope?.["src/alpha/a.ts"]?.ranges).toEqual(
				[{ start: 1, end: 1 }],
			);
			expect(scope.classification.carryover?.map((f) => f.file)).toEqual([
				"src/alpha/keep.ts",
			]);
		} finally {
			process.chdir(originalCwd);
			repo.cleanup();
		}
	});

	test("histórico reescrito (HEAD sem ancestrais comuns) cai no completo", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		try {
			process.chdir(repo.cwd);
			// `repo.head` não é ancestral de `repo.base` → revisão completa.
			const scope = await new ReviewScopeResolver(
				options({ base: repo.base }),
				fakeHoundsmanConfig,
			).resolve(stateWith(repo.head), repo.base);

			expect(scope.kind).toBe("review");
			if (scope.kind !== "review") throw new Error("esperava review");
			expect(scope.classification.mode).toBe("full");
		} finally {
			process.chdir(originalCwd);
			repo.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Integração: prepare/finalize no mesmo commit
// ---------------------------------------------------------------------------

describe("prepare/finalize — mesmo commit", () => {
	test("no-op preserva relatório e não gera briefs", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		const originalHome = process.env.HOUNDSMAN_HOME;
		let storage: SQLiteStorageProvider | null = null;

		try {
			process.env.HOUNDSMAN_HOME = join(repo.cwd, ".home");
			process.chdir(repo.cwd);

			storage = new SQLiteStorageProvider(join(repo.cwd, "houndsman.db"));
			const record = storage.getOrCreateReview({
				repo: resolveRepoIdentity(),
				branch: "main",
				slug: "main",
			});
			const opts = {
				...defaultOptions(),
				base: repo.base,
				head: "HEAD",
				noJev: true,
			};

			let ctx = reviewContext(storage, record);
			await prepare(opts, "main", fakeHoundsmanConfig, ctx);
			expect(storage.getReview(record.id)?.status).toBe("reviewing");

			writeFileSync(
				ctx.work.findingFile("alpha"),
				`${JSON.stringify(
					{
						watchdogId: "alpha",
						reviewedFiles: ["src/alpha/a.ts"],
						skipped: [],
						findings: [
							{
								rule: "regra",
								severity: "blocking",
								file: "src/alpha/a.ts",
								line: 1,
								message: "achado",
								action: "corrigir",
							},
						],
					},
					null,
					2,
				)}\n`,
			);
			finalize(opts, "main", fakeHoundsmanConfig, ctx);

			const classificationBefore = storage.readArtifact(
				record.id,
				"classification.json",
			)?.content;
			const reportBefore = storage.readArtifact(record.id, "review.md")?.content;
			const findingsBefore = JSON.stringify(
				storage.readFindings(record.id)?.findings,
			);
			const reviewedBefore = storage.getReview(record.id)?.reviewedSha;
			expect(classificationBefore).toBeTruthy();
			expect(reportBefore).toContain("src/alpha/a.ts");

			// Mesmo commit: prepare vira no-op e nada é reescrito.
			ctx = reviewContext(storage, storage.getReview(record.id) ?? record);
			const again = await prepare(opts, "main", fakeHoundsmanConfig, ctx);
			expect(again.messages.join("\n")).toContain(
				"Nenhuma alteração desde a última revisão",
			);
			expect(storage.readArtifact(record.id, "classification.json")?.content).toBe(
				classificationBefore,
			);
			expect(storage.readArtifact(record.id, "review.md")?.content).toBe(
				reportBefore,
			);
			expect(storage.getReview(record.id)?.status).toBe("review_done");
			expect(existsSync(ctx.work.briefFile("alpha"))).toBe(false);

			// Finalize sem ciclo preparado: no-op (não degrada o relatório).
			const finalizedAgain = finalize(
				opts,
				"main",
				fakeHoundsmanConfig,
				reviewContext(storage, storage.getReview(record.id) ?? record),
			);
			expect(finalizedAgain.messages.join("\n")).toContain("Nada a finalizar");
			expect(storage.readArtifact(record.id, "review.md")?.content).toBe(
				reportBefore,
			);
			expect(JSON.stringify(storage.readFindings(record.id)?.findings)).toBe(
				findingsBefore,
			);
			expect(storage.getReview(record.id)?.reviewedSha).toBe(reviewedBefore);
		} finally {
			storage?.close();
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			repo.cleanup();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Run vazia
// ---------------------------------------------------------------------------

describe("prepare sem alterações", () => {
	test("run recém-criada é descartada (sem run vazia na lista)", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		const originalHome = process.env.HOUNDSMAN_HOME;
		let storage: SQLiteStorageProvider | null = null;

		try {
			process.env.HOUNDSMAN_HOME = join(repo.cwd, ".home");
			process.chdir(repo.cwd);

			storage = new SQLiteStorageProvider(join(repo.cwd, "houndsman.db"));
			const record = storage.getOrCreateReview({
				repo: resolveRepoIdentity(),
				branch: "main",
				slug: "main",
			});
			const opts = {
				...defaultOptions(),
				base: repo.head,
				head: "HEAD",
				noJev: true,
			};

			const result = await prepare(
				opts,
				"main",
				fakeHoundsmanConfig,
				reviewContext(storage, record),
			);
			expect(result.messages.join("\n")).toContain("nenhuma run criada");
			expect(storage.getReview(record.id)).toBeNull();
			expect(storage.listArtifacts(record.id)).toHaveLength(0);

			// Run com artefatos anteriores (contexto) continua existindo.
			const kept = storage.getOrCreateReview({
				repo: resolveRepoIdentity(),
				branch: "main",
				slug: "main",
			});
			storage.writeArtifact(kept.id, {
				name: "context.json",
				kind: "context",
				content: "{}\n",
			});
			await prepare(
				opts,
				"main",
				fakeHoundsmanConfig,
				reviewContext(storage, kept),
			);
			expect(storage.getReview(kept.id)?.status).toBe("review_done");
			expect(storage.readArtifact(kept.id, "context.json")).not.toBeNull();
		} finally {
			storage?.close();
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			repo.cleanup();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Progresso do prepare
// ---------------------------------------------------------------------------

describe("prepare — progresso", () => {
	test("emite início/fim das etapas que realmente rodam", async () => {
		const repo = makeRepo();
		const originalCwd = process.cwd();
		const originalHome = process.env.HOUNDSMAN_HOME;
		let storage: SQLiteStorageProvider | null = null;

		try {
			process.env.HOUNDSMAN_HOME = join(repo.cwd, ".home");
			process.chdir(repo.cwd);

			storage = new SQLiteStorageProvider(join(repo.cwd, "houndsman.db"));
			const record = storage.getOrCreateReview({
				repo: resolveRepoIdentity(),
				branch: "main",
				slug: "main",
			});
			const opts = {
				...defaultOptions(),
				base: repo.base,
				head: "HEAD",
				noJev: true,
				noAst: true,
			};

			const events: PrepareProgressEvent[] = [];
			await prepare(
				opts,
				"main",
				fakeHoundsmanConfig,
				reviewContext(storage, record),
				undefined,
				undefined,
				(event) => events.push(event),
			);

			const starts = events
				.filter((event) => event.type === "start")
				.map((event) => event.stage);
			expect(starts).toEqual(["diff", "classify", "briefs", "manifest"]);
			const done = events.filter((event) => event.type === "done");
			expect(done.map((event) => event.stage)).toEqual(starts);
			for (const event of done) {
				if (event.type === "done") {
					expect(event.durationMs).toBeGreaterThanOrEqual(0);
				}
			}
		} finally {
			storage?.close();
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			repo.cleanup();
		}
	}, 30_000);
});
