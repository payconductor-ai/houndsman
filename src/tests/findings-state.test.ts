import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyFindingUpdate,
	buildStateFromFindings,
	emptyState,
	FindingsStateStore,
	fileReader,
	filterFindings,
	summarize,
	syncState,
} from "../core/findings-state";
import type { MergedFinding } from "../core/report-builder";
import type { Severity } from "../core/types";

/** Projeto em disco temporário (limpo no fim). */
function makeProject(files: Record<string, string>): {
	cwd: string;
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "houndsman-state-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = join(cwd, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function merged(
	partial: Partial<MergedFinding> & { file: string; rule: string },
): MergedFinding {
	return {
		rule: partial.rule,
		severity: (partial.severity ?? "attention") as Severity,
		file: partial.file,
		line: partial.line,
		message: partial.message ?? "msg",
		action: partial.action ?? "ação",
		evidence: partial.evidence,
		watchdogs: partial.watchdogs ?? ["alpha"],
	};
}

const DUPLICATED = [
	"function a() {",
	'\tconsole.log("x");',
	"}",
	"function b() {",
	'\tconsole.log("x");',
	"}",
].join("\n");

const AFTER_FIX = [
	"function a() {",
	"}",
	"function b() {",
	'\tconsole.log("x");',
	"}",
].join("\n");

describe("buildStateFromFindings", () => {
	test("cria entradas pendentes com id e ancora a linha", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const findings = [
				merged({ file: "src/f.ts", rule: "r", line: 2 }),
				merged({ file: "src/f.ts", rule: "r", line: 5 }),
			];
			const state = buildStateFromFindings(findings, {
				branch: "feature/x",
				readFile: fileReader(project.cwd),
			});

			expect(state.slug).toBe("feature-x");
			expect(Object.keys(state.findings)).toHaveLength(2);
			// Os ids voltam para os findings (usados no relatório).
			expect(findings[0].id).toBeTruthy();
			expect(findings[0].id).not.toBe(findings[1].id);
			for (const finding of Object.values(state.findings)) {
				expect(finding.decision).toBe("pending");
				expect(finding.execState).toBe("pending");
				expect(finding.present).toBe(true);
				expect(finding.line).toBeGreaterThan(0);
			}
		} finally {
			project.cleanup();
		}
	});

	test("preserva id e decisão entre execuções (casa por fingerprint)", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const reader = fileReader(project.cwd);
			const first = buildStateFromFindings(
				[merged({ file: "src/f.ts", rule: "r", line: 2 })],
				{ branch: "main", readFile: reader },
			);
			const id = Object.keys(first.findings)[0];
			applyFindingUpdate(first.findings[id], { decision: "ignore" });

			const second = buildStateFromFindings(
				[merged({ file: "src/f.ts", rule: "r", line: 2 })],
				{ branch: "main", readFile: reader, previous: first },
			);
			expect(Object.keys(second.findings)).toEqual([id]);
			expect(second.findings[id].decision).toBe("ignore");
		} finally {
			project.cleanup();
		}
	});

	test("finding que sumiu fica ausente e vira done se era 'execute'", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const reader = fileReader(project.cwd);
			const first = buildStateFromFindings(
				[merged({ file: "src/f.ts", rule: "r", line: 2 })],
				{ branch: "main", readFile: reader },
			);
			const id = Object.keys(first.findings)[0];
			applyFindingUpdate(first.findings[id], { decision: "execute" });

			const second = buildStateFromFindings([], {
				branch: "main",
				readFile: reader,
				previous: first,
			});
			expect(second.findings[id].present).toBe(false);
			expect(second.findings[id].execState).toBe("done");
		} finally {
			project.cleanup();
		}
	});

	test("ocorrências idênticas (mesmo contexto) viram um grupo com count", () => {
		const content = [
			"const a = 1;",
			'console.log("x");',
			"const a = 1;",
			'console.log("x");',
			"const a = 1;",
		].join("\n");
		const project = makeProject({ "src/g.ts": content });
		try {
			const findings = [
				merged({ file: "src/g.ts", rule: "r", line: 2 }),
				merged({ file: "src/g.ts", rule: "r", line: 4 }),
			];
			const state = buildStateFromFindings(findings, {
				branch: "main",
				readFile: fileReader(project.cwd),
			});
			expect(Object.keys(state.findings)).toHaveLength(1);
			const only = Object.values(state.findings)[0];
			expect(only.count).toBe(2);
			expect(findings[0].id).toBe(findings[1].id);
		} finally {
			project.cleanup();
		}
	});
});

describe("syncState", () => {
	test("move a sobrevivente de linha e marca a removida como stale/done", () => {
		const before = makeProject({ "src/f.ts": DUPLICATED });
		const after = makeProject({ "src/f.ts": AFTER_FIX });
		try {
			const state = buildStateFromFindings(
				[
					merged({ file: "src/f.ts", rule: "r", line: 2 }),
					merged({ file: "src/f.ts", rule: "r", line: 5 }),
				],
				{ branch: "main", readFile: fileReader(before.cwd) },
			);
			const ids = Object.keys(state.findings);
			// A primeira ocorrência foi marcada para executar.
			const firstId = ids[0];
			applyFindingUpdate(state.findings[firstId], { decision: "execute" });

			const result = syncState(state, fileReader(after.cwd));
			expect(result.moved).toHaveLength(1);
			expect(result.stale).toHaveLength(1);
			expect(result.stale).toContain(firstId);
			expect(state.findings[firstId].execState).toBe("done");

			const survivor = state.findings[result.moved[0]];
			expect(survivor.line).toBe(4);
		} finally {
			before.cleanup();
			after.cleanup();
		}
	});
});

describe("filterFindings / summarize", () => {
	test("filtra por decisão e severity, e resume as contagens", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const state = buildStateFromFindings(
				[
					merged({
						file: "src/f.ts",
						rule: "r",
						line: 2,
						severity: "blocking",
					}),
					merged({ file: "src/f.ts", rule: "r2", line: 5, severity: "nit" }),
				],
				{ branch: "main", readFile: fileReader(project.cwd) },
			);
			const ids = Object.keys(state.findings);
			applyFindingUpdate(state.findings[ids[0]], { decision: "execute" });

			expect(
				filterFindings(state, { decision: "execute" }).map((f) => f.id),
			).toEqual([ids[0]]);
			expect(filterFindings(state, { severity: "nit" }).map((f) => f.id)).toEqual([
				ids[1],
			]);

			const summary = summarize(state);
			expect(summary.total).toBe(2);
			expect(summary.byDecision.execute).toBe(1);
			expect(summary.byDecision.pending).toBe(1);
			expect(summary.bySeverity.blocking).toBe(1);
		} finally {
			project.cleanup();
		}
	});
});

describe("FindingsStateStore", () => {
	test("grava e lê o state.json de forma atômica", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		const outDir = join(project.cwd, "artifacts");
		try {
			const store = FindingsStateStore.at(outDir, "feature/x");
			const state = buildStateFromFindings(
				[merged({ file: "src/f.ts", rule: "r", line: 2 })],
				{ branch: "feature/x", readFile: fileReader(project.cwd) },
			);
			store.write(state);

			expect(store.filePath).toBe(join(outDir, "feature-x", "state.json"));
			expect(existsSync(store.filePath)).toBe(true);
			const read = store.read();
			expect(read?.slug).toBe("feature-x");
			expect(Object.keys(read?.findings ?? {})).toHaveLength(1);
		} finally {
			project.cleanup();
		}
	});

	test("read devolve null quando o arquivo não existe", () => {
		const project = makeProject({});
		try {
			const store = FindingsStateStore.at(join(project.cwd, "artifacts"), "main");
			expect(store.read()).toBeNull();
			expect(store.update(() => {})).toBeTruthy();
		} finally {
			project.cleanup();
		}
	});

	test("emptyState cria um estado vazio válido", () => {
		const state = emptyState("feature/x");
		expect(state.version).toBe(2);
		expect(state.slug).toBe("feature-x");
		expect(state.findings).toEqual({});
	});
});

describe("rastreio de revisão (incremental)", () => {
	test("carimba reviewed e foundAtSha nos findings do ciclo", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const state = buildStateFromFindings(
				[merged({ file: "src/f.ts", rule: "r", line: 2 })],
				{
					branch: "main",
					readFile: fileReader(project.cwd),
					headSha: "abc1234",
					reviewed: { headSha: "abc1234", at: "2026-01-01T00:00:00.000Z" },
				},
			);
			expect(state.reviewed?.headSha).toBe("abc1234");
			const only = Object.values(state.findings)[0];
			expect(only.foundAtSha).toBe("abc1234");
		} finally {
			project.cleanup();
		}
	});

	test("carry-over preserva o foundAtSha original", () => {
		const project = makeProject({ "src/f.ts": DUPLICATED });
		try {
			const state = buildStateFromFindings(
				[
					// Novo/re-reportado: recebe o head atual.
					merged({ file: "src/f.ts", rule: "r", line: 2 }),
					// Carry-over: carrega o `foundAtSha` de quando foi observado.
					{
						...merged({ file: "src/f.ts", rule: "r2", line: 5 }),
						foundAtSha: "old0001",
					},
				],
				{
					branch: "main",
					readFile: fileReader(project.cwd),
					headSha: "new0002",
					reviewed: { headSha: "new0002", at: "2026-01-02T00:00:00.000Z" },
				},
			);
			const byRule = (rule: string): string | undefined =>
				Object.values(state.findings).find((f) => f.rule === rule)?.foundAtSha;
			expect(byRule("r")).toBe("new0002");
			expect(byRule("r2")).toBe("old0001");
		} finally {
			project.cleanup();
		}
	});
});
