/**
 * Worktrees: criação isolada por PR e revisões paralelas.
 *
 * Exercita o caminho real (git + gh fake): resolver a PR, criar o worktree
 * detached, preparar duas revisões em paralelo e garantir que cada uma lê a
 * sua própria árvore.
 */

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
import { basename, join } from "node:path";
import { parseReviewArgs } from "../core/commands/review";
import { HoundsmanEngine } from "../core/engine/houndsman-engine";
import { resolveReviewWorkspace } from "../core/engine/review-workspace";
import { createGitRunner } from "../core/git-runner";
import { defaultOptions } from "../core/orchestrator";
import type { GhRunner } from "../core/services/gh-client";
import { GitRepository } from "../core/services/git-repository";
import {
	parseWorktreeList,
	syncProjectLayer,
	syncProjectLayerForRoot,
	WorktreeManager,
} from "../core/services/worktree-manager";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import { parseHuntArgs } from "../harness/hunt/hunt-options";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

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

type Sandbox = {
	root: string;
	origin: string;
	repo: string;
	home: string;
	mainSha: string;
	featureSha: string;
	cleanup: () => void;
};

/** Remote bare + clone com `main` e uma branch `feature`. */
function makeSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "houndsman-worktree-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const home = join(root, "home");

	git(root, ["init", "--bare", "-b", "main", origin]);
	git(root, ["init", "-b", "main", repo]);
	git(repo, ["config", "user.email", "wt@example.test"]);
	git(repo, ["config", "user.name", "Worktree"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	git(repo, ["config", "tag.gpgsign", "false"]);
	git(repo, ["remote", "add", "origin", origin]);

	mkdirSync(join(repo, "src", "alpha"), { recursive: true });
	writeFileSync(join(repo, "README.md"), "# Fake\n");
	writeFileSync(join(repo, "src", "alpha", "a.ts"), "export const a = 1;\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "initial"]);
	const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
	git(repo, ["push", "-u", "origin", "main"]);

	git(repo, ["checkout", "-b", "feature"]);
	writeFileSync(join(repo, "src", "alpha", "a.ts"), "export const a = 2; // pr\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "feature"]);
	const featureSha = git(repo, ["rev-parse", "HEAD"]).trim();
	git(repo, ["push", "-u", "origin", "feature"]);
	git(repo, ["checkout", "main"]);

	return {
		root,
		origin,
		repo,
		home,
		mainSha,
		featureSha,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** `gh` fake devolvendo a PR 7 apontando para a branch `feature`. */
function fakeGh(
	sandbox: Sandbox,
	headRef = "feature",
	headSha = sandbox.featureSha,
): GhRunner {
	return (args) => {
		if (args[0] === "pr" && args[1] === "view") {
			return {
				ok: true,
				code: 0,
				stdout: JSON.stringify({
					number: 7,
					title: "Feature",
					headRefName: headRef,
					baseRefName: "main",
					headRefOid: headSha,
					isCrossRepository: false,
					isDraft: false,
					url: "https://example.test/pr/7",
				}),
				stderr: "",
			};
		}
		return { ok: false, code: 1, stdout: "", stderr: "unexpected gh call" };
	};
}

describe("flags de worktree", () => {
	test("parse de review/hunt e exclusão mútua", () => {
		expect(parseReviewArgs(["--pr", "7"]).pr).toBe(7);
		expect(parseReviewArgs(["--worktree", "/tmp/wt"]).worktree).toBe("/tmp/wt");
		expect(() => parseReviewArgs(["--pr", "7", "--worktree", "/tmp/wt"])).toThrow();
		expect(parseHuntArgs(["--pr", "8"]).pr).toBe(8);
	});
});

describe("parseWorktreeList", () => {
	test("lê main e worktree detached", () => {
		const entries = parseWorktreeList(
			[
				"worktree /repo",
				"HEAD 1111111111111111111111111111111111111111",
				"branch refs/heads/main",
				"",
				"worktree /home/worktrees/repo/feature",
				"HEAD 2222222222222222222222222222222222222222",
				"detached",
				"",
			].join("\n"),
		);
		expect(entries).toHaveLength(2);
		expect(entries[0].branch).toBe("refs/heads/main");
		expect(entries[1].detached).toBe(true);
		expect(entries[1].head?.startsWith("2222")).toBe(true);
	});
});

describe("nomes de diretório do worktree", () => {
	const manager = new WorktreeManager(
		new GitRepository(createGitRunner(process.cwd())),
		{
			repoKey: "remote:github.com/tradinglabs-io/pay.conductor",
			repoRoot: process.cwd(),
			baseDir: join(tmpdir(), "houndsman-worktrees"),
		},
	);

	test("repo e branch são slugs curtos com hash", () => {
		// MAX_PATH do Windows: cada segmento fica limitado a legível + hash8.
		expect(basename(manager.baseDir).length).toBeLessThanOrEqual(24 + 9);
		expect(basename(manager.pathFor("main"))).toMatch(/^main-[0-9a-f]{8}$/);

		const long = manager.pathFor("feat/fetch-branch-balance-split-accounts");
		const name = basename(long);
		expect(name).toMatch(/^[\w.-]{1,20}-[0-9a-f]{8}$/);
		expect(name.length).toBeLessThanOrEqual(20 + 9);
		expect(long.startsWith(manager.baseDir)).toBe(true);
	});

	test("é determinístico e não colide em prefixos iguais", () => {
		const branch = "feat/fetch-branch-balance-split-accounts";
		expect(manager.pathFor(branch)).toBe(manager.pathFor(branch));
		expect(manager.pathFor(branch)).not.toBe(
			manager.pathFor("feat/fetch-branch-balance-split-other"),
		);
	});

	test("branches só de caracteres inválidos caem no fallback", () => {
		expect(basename(manager.pathFor("///"))).toMatch(/^branch-[0-9a-f]{8}$/);
	});
});

describe("camada gerada no worktree", () => {
	test("espelha `.houndsman/core` do clone principal e ignora origem ausente", () => {
		const sandbox = makeSandbox();
		try {
			const worktree = join(sandbox.root, "wt-layer");
			mkdirSync(worktree, { recursive: true });
			mkdirSync(join(sandbox.repo, ".houndsman", "core"), { recursive: true });
			writeFileSync(
				join(sandbox.repo, ".houndsman", "core", "types.ts"),
				"export {};\n",
			);

			expect(syncProjectLayer(sandbox.repo, worktree)).toBe(true);
			expect(existsSync(join(worktree, ".houndsman", "core", "types.ts"))).toBe(
				true,
			);

			// Sem camada na origem: no-op (fail-open).
			const empty = join(sandbox.root, "empty");
			mkdirSync(empty, { recursive: true });
			expect(syncProjectLayer(empty, worktree)).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});

	test("ensure copia a camada e o auto-reparo repõe num worktree existente", () => {
		const sandbox = makeSandbox();
		try {
			mkdirSync(join(sandbox.repo, ".houndsman", "core"), { recursive: true });
			writeFileSync(
				join(sandbox.repo, ".houndsman", "core", "types.ts"),
				"export {};\n",
			);
			const manager = new WorktreeManager(
				new GitRepository(createGitRunner(sandbox.repo)),
				{
					repoKey: "path:fake",
					repoRoot: sandbox.repo,
					baseDir: sandbox.home,
				},
			);

			const ensured = manager.ensure({
				branch: "feature",
				ref: sandbox.featureSha,
			});
			const layer = join(ensured.path, ".houndsman", "core", "types.ts");
			expect(existsSync(layer)).toBe(true);

			// Comando rodando no worktree (sem `--pr`) também se auto-repara.
			rmSync(join(ensured.path, ".houndsman", "core"), {
				recursive: true,
				force: true,
			});
			expect(syncProjectLayerForRoot(ensured.path)).toBe(true);
			expect(existsSync(layer)).toBe(true);

			manager.remove("feature");
		} finally {
			sandbox.cleanup();
		}
	}, 20_000);
});

describe("WorktreeManager", () => {
	test("cria detached, reusa o mesmo commit e remove", () => {
		const sandbox = makeSandbox();
		try {
			const gitRepo = new GitRepository(createGitRunner(sandbox.repo));
			const manager = new WorktreeManager(gitRepo, {
				repoKey: "path:fake",
				repoRoot: sandbox.repo,
				baseDir: sandbox.home,
			});

			const first = manager.ensure({ branch: "feature", ref: sandbox.featureSha });
			expect(first.created).toBe(true);
			expect(existsSync(first.path)).toBe(true);
			expect(
				readFileSync(join(first.path, "src", "alpha", "a.ts"), "utf8"),
			).toContain("// pr");

			const second = manager.ensure({ branch: "feature", ref: sandbox.featureSha });
			expect(second.created).toBe(false);
			expect(second.reused).toBe(true);
			expect(second.path).toBe(first.path);

			const removed = manager.remove("feature");
			expect(removed.removed).toBe(true);
			expect(existsSync(first.path)).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	}, 20_000);
});

describe("revisões paralelas em worktrees", () => {
	test("resolve a PR, prepara no worktree e persiste o caminho", async () => {
		const sandbox = makeSandbox();
		const originalHome = process.env.HOUNDSMAN_HOME;
		try {
			const workspace = resolveReviewWorkspace(
				{ cwd: sandbox.repo, base: "main", head: "HEAD", pr: 7 },
				{ ghRunner: fakeGh(sandbox) },
			);

			// Default: worktree dentro do workspace (evita prompts de permissão).
			expect(
				workspace.root.startsWith(join(sandbox.repo, ".houndsman", "worktrees")),
			).toBe(true);
			expect(workspace.branch).toBe("feature");
			expect(workspace.prNumber).toBe(7);
			expect(workspace.base).toBe("origin/main");
			expect(workspace.worktreePath).toBe(workspace.root);
			expect(existsSync(join(workspace.root, "src", "alpha", "a.ts"))).toBe(true);

			// Rodar de dentro do worktree não volta para o clone principal.
			const inside = resolveReviewWorkspace({
				cwd: workspace.root,
				base: "main",
				head: "HEAD",
				branch: "feature",
			});
			expect(inside.root).toBe(workspace.root);
			expect(inside.mainRoot).toBe(workspace.mainRoot);

			process.env.HOUNDSMAN_HOME = sandbox.home;
			const storage = new SQLiteStorageProvider(join(sandbox.home, "test.db"));
			const engine = new HoundsmanEngine(fakeHoundsmanConfig, {
				root: workspace.root,
				mainRoot: workspace.mainRoot,
				repo: workspace.repo,
				storage,
			});

			const session = engine.session({
				...defaultOptions(),
				branch: workspace.branch,
				base: workspace.base,
				head: workspace.head,
				pr: workspace.prNumber,
				worktreePath: workspace.worktreePath,
				noJev: true,
				noAi: true,
			});
			await session.prepare();

			const classification = storage.readArtifact(
				session.context.review.id,
				"classification.json",
			);
			expect(classification?.content).toContain("src/alpha/a.ts");
			expect(session.context.review.worktreePath).toBe(workspace.root);
			expect(session.context.review.prNumber).toBe(7);

			const brief = storage.readArtifact(
				session.context.review.id,
				"briefs/alpha.md",
			);
			expect(brief?.content).toContain(`**Worktree:** \`${workspace.root}\``);

			// Staging também fica dentro do worktree (briefs/findings/contexto).
			expect(
				session.context.work.root.startsWith(
					join(workspace.root, ".houndsman", "work"),
				),
			).toBe(true);

			// O clone principal não foi tocado (continua em main).
			expect(git(sandbox.repo, ["branch", "--show-current"]).trim()).toBe("main");
			storage.close();
		} finally {
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			sandbox.cleanup();
		}
	}, 30_000);

	test("duas PRs preparam em paralelo sem se contaminar", async () => {
		const sandbox = makeSandbox();
		const originalHome = process.env.HOUNDSMAN_HOME;
		try {
			// Segunda branch com arquivo próprio.
			git(sandbox.repo, ["checkout", "-b", "feature-b", "main"]);
			writeFileSync(
				join(sandbox.repo, "src", "alpha", "b.ts"),
				"export const b = 1;\n",
			);
			git(sandbox.repo, ["add", "-A"]);
			git(sandbox.repo, ["commit", "-m", "feature b"]);
			const featureBSha = git(sandbox.repo, ["rev-parse", "HEAD"]).trim();
			git(sandbox.repo, ["push", "-u", "origin", "feature-b"]);
			git(sandbox.repo, ["checkout", "main"]);

			process.env.HOUNDSMAN_HOME = sandbox.home;
			const storage = new SQLiteStorageProvider(join(sandbox.home, "parallel.db"));

			const ghA = fakeGh(sandbox);
			const ghB: GhRunner = (args) => {
				if (args[0] === "pr" && args[1] === "view" && args[2] === "8") {
					return {
						ok: true,
						code: 0,
						stdout: JSON.stringify({
							number: 8,
							title: "Feature B",
							headRefName: "feature-b",
							baseRefName: "main",
							headRefOid: featureBSha,
							isCrossRepository: false,
							isDraft: false,
						}),
						stderr: "",
					};
				}
				return { ok: false, code: 1, stdout: "", stderr: "unexpected gh call" };
			};

			const workspaceA = resolveReviewWorkspace(
				{ cwd: sandbox.repo, base: "main", head: "HEAD", pr: 7 },
				{ ghRunner: ghA },
			);
			const workspaceB = resolveReviewWorkspace(
				{ cwd: sandbox.repo, base: "main", head: "HEAD", pr: 8 },
				{ ghRunner: ghB },
			);
			expect(workspaceA.root).not.toBe(workspaceB.root);

			const options = (workspace: typeof workspaceA) => ({
				...defaultOptions(),
				branch: workspace.branch,
				base: workspace.base,
				head: workspace.head,
				pr: workspace.prNumber,
				worktreePath: workspace.worktreePath,
				noJev: true,
				noAi: true,
			});

			const engineA = new HoundsmanEngine(fakeHoundsmanConfig, {
				root: workspaceA.root,
				mainRoot: workspaceA.mainRoot,
				repo: workspaceA.repo,
				storage,
			});
			const engineB = new HoundsmanEngine(fakeHoundsmanConfig, {
				root: workspaceB.root,
				mainRoot: workspaceB.mainRoot,
				repo: workspaceB.repo,
				storage,
			});

			const [sessionA, sessionB] = [
				engineA.session(options(workspaceA)),
				engineB.session(options(workspaceB)),
			];
			await Promise.all([sessionA.prepare(), sessionB.prepare()]);

			const classA = storage.readArtifact(
				sessionA.context.review.id,
				"classification.json",
			);
			const classB = storage.readArtifact(
				sessionB.context.review.id,
				"classification.json",
			);

			expect(classA?.content).toContain("src/alpha/a.ts");
			expect(classA?.content).not.toContain("src/alpha/b.ts");
			expect(classB?.content).toContain("src/alpha/b.ts");
			expect(classB?.content).not.toContain("src/alpha/a.ts");
			expect(storage.listReviews(workspaceA.repo.key)).toHaveLength(2);
			storage.close();
		} finally {
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			sandbox.cleanup();
		}
	}, 30_000);
});
