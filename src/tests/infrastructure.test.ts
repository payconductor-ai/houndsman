/**
 * Infraestrutura (Fase 1 do refactor OO): git, gh, filesystem e layout da run.
 *
 * Testa as classes com runners injetáveis — sem tocar no git/gh reais.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult, GitRunner } from "../core/git-runner";
import { RunLayout } from "../core/run-layout";
import { GhClient, type GhRunner } from "../core/services/gh-client";
import { GitRepository } from "../core/services/git-repository";
import { ProjectFiles } from "../core/services/project-files";

/** Runner roteado por `args.join(" ")`, registrando as chamadas. */
function fakeGit(routes: Record<string, GitResult>): {
	calls: string[][];
	runner: GitRunner;
} {
	const calls: string[][] = [];
	const runner: GitRunner = (args) => {
		calls.push(args);
		return (
			routes[args.join(" ")] ?? {
				ok: false,
				code: 1,
				stdout: "",
				stderr: "rota não mockada",
			}
		);
	};
	return { calls, runner };
}

describe("GitRepository", () => {
	test("resolveSha apara o stdout", () => {
		const { runner } = fakeGit({
			"rev-parse HEAD": { ok: true, code: 0, stdout: "abc123\n", stderr: "" },
		});
		expect(new GitRepository(runner).resolveSha("HEAD")).toBe("abc123");
	});

	test("currentBranch devolve null quando falha ou está vazio", () => {
		const empty = fakeGit({
			"branch --show-current": { ok: true, code: 0, stdout: "\n", stderr: "" },
		});
		expect(new GitRepository(empty.runner).currentBranch()).toBeNull();

		const failing = fakeGit({});
		expect(new GitRepository(failing.runner).currentBranch()).toBeNull();
	});

	test("isAncestor usa o exit code sem lançar", () => {
		const { runner } = fakeGit({
			"merge-base --is-ancestor a b": {
				ok: true,
				code: 0,
				stdout: "",
				stderr: "",
			},
			"merge-base --is-ancestor b a": {
				ok: false,
				code: 1,
				stdout: "",
				stderr: "",
			},
		});
		const git = new GitRepository(runner);
		expect(git.isAncestor("a", "b")).toBe(true);
		expect(git.isAncestor("b", "a")).toBe(false);
	});

	test("readFileAt devolve null quando o commit não tem o arquivo", () => {
		const { runner } = fakeGit({
			"show abc:src/a.ts": { ok: true, code: 0, stdout: "conteúdo", stderr: "" },
		});
		const git = new GitRepository(runner);
		expect(git.readFileAt("abc", "src/a.ts")).toBe("conteúdo");
		expect(git.readFileAt("abc", "src/missing.ts")).toBeNull();
	});

	test("diffNameStatus monta o intervalo base...head", () => {
		const { calls, runner } = fakeGit({
			"diff main...HEAD --name-status": {
				ok: true,
				code: 0,
				stdout: "M\tsrc/a.ts\n",
				stderr: "",
			},
		});
		new GitRepository(runner).diffNameStatus("main", "HEAD");
		expect(calls).toEqual([["diff", "main...HEAD", "--name-status"]]);
	});

	test("diffNumstat e collectDiffSince parseiam churn e patch", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		const { runner } = fakeGit({
			"diff from..to": { ok: true, code: 0, stdout: patch, stderr: "" },
			"diff --numstat -z from..to": {
				ok: true,
				code: 0,
				stdout: "1\t2\tsrc/a.ts\0",
				stderr: "",
			},
		});
		const diff = new GitRepository(runner).collectDiffSince("from", "to");
		expect(diff.churn.get("src/a.ts")).toEqual({ additions: 1, deletions: 2 });
		expect(diff.byFile.get("src/a.ts")).toContain("+new");
	});
});

describe("GhClient", () => {
	test("delega ao runner injetado", () => {
		const calls: string[][] = [];
		const runner: GhRunner = (args) => {
			calls.push(args);
			return { ok: true, code: 0, stdout: "ok", stderr: "" };
		};
		const result = new GhClient(runner).run(["auth", "status"]);
		expect(result.stdout).toBe("ok");
		expect(calls).toEqual([["auth", "status"]]);
	});
});

describe("ProjectFiles", () => {
	test("lê, escreve, lê JSON e resolve relativo ao cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-files-"));
		try {
			const files = new ProjectFiles(cwd);
			files.write("dir/a.txt", "conteúdo");
			files.write("dir/b.json", JSON.stringify({ ok: true }));

			expect(files.read("dir/a.txt")).toBe("conteúdo");
			expect(files.read("dir/missing.txt")).toBeNull();
			expect(files.readJson<{ ok: boolean }>("dir/b.json")).toEqual({ ok: true });
			expect(files.readJson("dir/a.txt")).toBeNull();
			expect(files.exists("dir/a.txt")).toBe(true);
			expect(files.reader()("dir/a.txt")).toBe("conteúdo");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("writeAtomic não deixa arquivo temporário", () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-files-atomic-"));
		try {
			const files = new ProjectFiles(cwd);
			files.writeAtomic("state.json", "{}");
			expect(files.read("state.json")).toBe("{}");
			expect(readdirSync(cwd)).toEqual(["state.json"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("RunLayout", () => {
	test("centraliza os caminhos da run (slug normalizado)", () => {
		const layout = new RunLayout(".houndsman/.runs", "feature/x");
		expect(layout.slug).toBe("feature-x");
		expect(layout.outDir.replace(/\\/g, "/")).toBe(".houndsman/.runs/feature-x");
		expect(layout.briefsDir.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/briefs",
		);
		expect(layout.findingsDir.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/findings",
		);
		expect(layout.stateFile.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/state.json",
		);
		expect(layout.runStatusFile.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/run.json",
		);
		expect(layout.classificationFile.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/classification.json",
		);
		expect(layout.domainReportFile("alpha").replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/review.alpha.md",
		);
		expect(layout.findingFile("alpha").replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/findings/alpha.json",
		);
		expect(layout.briefFile("alpha").replace(/\\/g, "/")).toBe(
			".houndsman/.runs/feature-x/briefs/alpha.md",
		);
	});

	test("contextPaths compartilha a pasta da run", () => {
		const paths = new RunLayout(".houndsman/.runs", "main").contextPaths;
		expect(paths.dir.replace(/\\/g, "/")).toBe(".houndsman/.runs/main");
		expect(paths.context.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/main/context.json",
		);
		expect(paths.summary.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/main/context-summary.json",
		);
		expect(paths.brief.replace(/\\/g, "/")).toBe(
			".houndsman/.runs/main/context-brief.md",
		);
	});
});
