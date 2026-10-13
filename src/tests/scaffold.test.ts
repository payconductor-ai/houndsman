import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScaffoldContext, syncGeneratedFiles } from "../core/commands/scaffold";

/** Cria um diretório temporário, roda `fn` e limpa ao final. */
function withTempDir(fn: (cwd: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "houndsman-scaffold-"));
	try {
		fn(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("scaffold — ponteiros de skill", () => {
	test("gera 1 skill 'houndsman' por harness e os docs de capability", () => {
		withTempDir((cwd) => {
			syncGeneratedFiles(createScaffoldContext(cwd, [], false));

			for (const harness of ["agents", "claude"]) {
				expect(
					existsSync(join(cwd, `.${harness}/skills/houndsman/SKILL.md`)),
				).toBe(true);
			}

			for (const name of ["hunt.md", "train.md", "fix.md"]) {
				expect(existsSync(join(cwd, ".houndsman/core/skill", name))).toBe(true);
			}
			// O entry point é o SKILL.md do harness — não um doc da camada.
			expect(existsSync(join(cwd, ".houndsman/core/skill/SKILL.md"))).toBe(false);
		});
	});

	test("o SKILL.md descreve as capabilities e resolve o projectName", () => {
		withTempDir((cwd) => {
			syncGeneratedFiles(createScaffoldContext(cwd, ["--name", "acme"], false));

			const skill = readFileSync(
				join(cwd, ".agents/skills/houndsman/SKILL.md"),
				"utf8",
			);
			for (const capability of ["hunt", "train", "fix"]) {
				expect(skill).toContain(capability);
			}
			expect(skill).toContain("acme");
			expect(skill).not.toContain("{{projectName}}");
		});
	});

	test("--harness none não gera ponteiros de harness", () => {
		withTempDir((cwd) => {
			syncGeneratedFiles(createScaffoldContext(cwd, ["--harness", "none"], false));
			expect(existsSync(join(cwd, ".agents"))).toBe(false);
			expect(existsSync(join(cwd, ".claude"))).toBe(false);
		});
	});
});
