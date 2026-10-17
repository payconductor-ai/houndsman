/**
 * Domínio (Fase 2 do refactor OO): watchdog, registry, config do projeto,
 * diff, classificação e descoberta de docs.
 */

import { describe, expect, test } from "bun:test";
import { defineHoundsmanConfig } from "../core/config";
import { DocDiscoverer, discoverDocs } from "../core/doc-discoverer";
import { Classification } from "../core/domain/classification";
import { Diff } from "../core/domain/diff";
import { matchesClassifyRule, Watchdog } from "../core/domain/watchdog";
import {
	emptyState,
	Finding,
	type FindingState,
	FindingsState,
} from "../core/findings-state";
import { ProjectConfig } from "../core/project-config";
import { defineWatchdog } from "../core/types";
import { WatchdogRegistry } from "../core/watchdog-registry";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

// ---------------------------------------------------------------------------
// Watchdog / WatchdogRegistry
// ---------------------------------------------------------------------------

describe("Watchdog", () => {
	const alpha = new Watchdog(fakeHoundsmanConfig.watchdogs.alpha);

	test("casa arquivos do próprio domínio", () => {
		expect(alpha.matches("src/alpha/a.ts")).toBe(true);
		expect(alpha.matches("src/beta/a.ts")).toBe(false);
	});

	test("ordena regras por severidade e expõe contexto sem regras", () => {
		expect(alpha.rules.map((rule) => rule.severity)).toEqual([
			"blocking",
			"attention",
			"suggestion",
		]);
		const context = alpha.context();
		expect(context.id).toBe("alpha");
		expect(context.contextFiles).toEqual(["README.md"]);
		expect("rules" in context).toBe(false);
	});

	test("casa por conteúdo quando a regra é type=content", () => {
		const probe = new Watchdog(
			defineWatchdog({
				id: "probe",
				name: "Probe",
				description: "Por conteúdo.",
				scope: "qualquer",
				classify: [{ type: "content", value: "NEEDLE" }],
				rules: [],
				contextFiles: [],
			}),
		);
		expect(probe.matches("a.ts", "// NEEDLE")).toBe(true);
		expect(probe.matches("a.ts", "sem alvo")).toBe(false);
		expect(probe.matches("a.ts")).toBe(false);
	});

	test("matchesClassifyRule respeita filename/content", () => {
		expect(
			matchesClassifyRule("src/alpha/a.ts", { value: "^src/alpha/" }, undefined),
		).toBe(true);
		expect(
			matchesClassifyRule("a.ts", { type: "content", value: "X" }, "contém X"),
		).toBe(true);
		expect(
			matchesClassifyRule("a.ts", { type: "content", value: "X" }, undefined),
		).toBe(false);
	});
});

describe("WatchdogRegistry", () => {
	const registry = new WatchdogRegistry(fakeHoundsmanConfig);

	test("resolve ids, nomes e buscas null-safe", () => {
		expect(registry.ids).toEqual(["alpha", "beta"]);
		expect(registry.get("alpha").name).toBe("Alpha");
		expect(registry.find("alpha")?.name).toBe("Alpha");
		expect(registry.find("nao-existe")).toBeNull();
		expect(registry.nameOf("nao-existe")).toBe("nao-existe");
		expect(registry.all()).toHaveLength(2);
	});

	test("contexto e matching por arquivo", () => {
		expect(registry.context("beta").contextFiles).toContain("README.md");
		expect(registry.matching("src/alpha/a.ts")).toEqual(["alpha"]);
		expect(registry.matching("lib/special.ts")).toEqual(["beta"]);
		expect(registry.matching("scripts/foo.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// ProjectConfig
// ---------------------------------------------------------------------------

describe("ProjectConfig", () => {
	test("resolve defaults e valores do projeto", () => {
		const project = new ProjectConfig(fakeHoundsmanConfig);
		expect(project.projectName).toBe("Fake Project");
		expect(project.storage).toEqual({});
		expect(project.maxFilesPerBrief).toBe(40);
		expect(project.jevConcurrency).toBe(5);
		expect(project.alwaysIncludeDocs).toEqual(["README.md"]);
		expect(project.watchdogs.ids).toEqual(["alpha", "beta"]);
	});

	test("sobrepõe orçamento/concorrência e ignora valores inválidos", () => {
		const custom = defineHoundsmanConfig({
			...fakeHoundsmanConfig,
			budgets: { maxFilesPerBrief: 60 },
			concurrency: { jev: 8 },
		});
		const project = new ProjectConfig(custom);
		expect(project.maxFilesPerBrief).toBe(60);
		expect(project.jevConcurrency).toBe(8);

		const invalid = defineHoundsmanConfig({
			...fakeHoundsmanConfig,
			budgets: { maxFilesPerBrief: 0 },
			concurrency: { jev: -1 },
		});
		const fallback = new ProjectConfig(invalid);
		expect(fallback.maxFilesPerBrief).toBe(40);
		expect(fallback.jevConcurrency).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// Diff / Classification
// ---------------------------------------------------------------------------

describe("Diff", () => {
	const diff = new Diff({
		byFile: new Map([["src/a.ts", "patch-a"]]),
		churn: new Map([
			["src/a.ts", { additions: 2, deletions: 1 }],
			["src/b.ts", { additions: 3, deletions: 0 }],
		]),
	});

	test("consulta patch, churn e totais", () => {
		expect(diff.paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(diff.patchFor("src/a.ts")).toBe("patch-a");
		expect(diff.patchFor("src/b.ts")).toBeUndefined();
		expect(diff.churnOf("src/a.ts")).toEqual({ additions: 2, deletions: 1 });
		expect(diff.churnOf("src/missing.ts")).toEqual({
			additions: 0,
			deletions: 0,
		});
		expect(diff.totals).toEqual({ additions: 5, deletions: 1 });
	});

	test("empty não tem paths nem churn", () => {
		expect(Diff.empty().paths).toEqual([]);
		expect(Diff.empty().totals).toEqual({ additions: 0, deletions: 0 });
	});
});

describe("Classification", () => {
	const data = {
		watchdogs: { alpha: ["src/a.ts", "src/b.ts"], beta: ["src/c.ts"] },
		files: {
			"src/a.ts": { status: "modified" as const },
			"src/b.ts": { status: "added" as const },
			"src/c.ts": { status: "modified" as const },
		},
		churn: {
			"src/a.ts": { additions: 10, deletions: 0 },
			"src/b.ts": { additions: 1, deletions: 0 },
			"src/c.ts": { additions: 4, deletions: 2 },
		},
		unclassified: ["scripts/x.ts"],
		excluded: ["dist/x.js"],
		deleted: [],
		stats: { alpha: 2, beta: 1 },
		excludedCount: 1,
		base: "main",
		head: "HEAD",
	};
	const classification = Classification.from(data);

	test("expõe coleções e ids ativos", () => {
		expect(classification.activeIds).toEqual(["alpha", "beta"]);
		expect(classification.watchdogsFor("alpha")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(classification.watchdogsFor("missing")).toEqual([]);
		expect(classification.unclassified).toEqual(["scripts/x.ts"]);
		expect(classification.excludedCount).toBe(1);
		expect(classification.base).toBe("main");
	});

	test("aplica o orçamento por risco", () => {
		expect(classification.budgetFor("alpha", 1)).toEqual({
			selected: ["src/a.ts"],
			overflow: ["src/b.ts"],
		});
		expect(classification.budgetFor("alpha", 40)).toEqual({
			selected: ["src/a.ts", "src/b.ts"],
			overflow: [],
		});
	});

	test("soma churn e serializa no shape do classification.json", () => {
		expect(classification.churnTotals).toEqual({ additions: 15, deletions: 2 });
		expect(classification.toJSON()).toBe(data);
	});
});

// ---------------------------------------------------------------------------
// DocDiscoverer
// ---------------------------------------------------------------------------

describe("DocDiscoverer", () => {
	test("sempre inclui docs e aplica os mapeamentos do projeto", () => {
		const config = defineHoundsmanConfig({
			...fakeHoundsmanConfig,
			alwaysIncludeDocs: ["AGENTS.md"],
			docMappings: [
				[/^src\//, ["docs/DOMAIN.md"]],
				[/\.test\.ts$/, ["docs/TESTS.md"]],
			],
		});
		const docs = new DocDiscoverer(config).discover([
			"src/alpha/a.ts",
			"src/alpha/a.test.ts",
			"scripts/foo.ts",
		]);
		expect(docs).toEqual(["AGENTS.md", "docs/DOMAIN.md", "docs/TESTS.md"]);
	});

	test("o adaptador discoverDocs delega para a classe", () => {
		expect(discoverDocs(["src/alpha/a.ts"], fakeHoundsmanConfig)).toEqual([
			"README.md",
		]);
	});
});

// ---------------------------------------------------------------------------
// Finding / FindingsState
// ---------------------------------------------------------------------------

/** Finding mínimo para os testes de domínio. */
function makeFinding(id: string, overrides: Partial<FindingState> = {}): FindingState {
	return {
		id,
		fingerprint: `fp-${id}`,
		watchdogIds: ["alpha"],
		rule: "R",
		severity: "blocking",
		file: "src/a.ts",
		line: 1,
		message: "m",
		action: "a",
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

describe("Finding / FindingsState", () => {
	const file = emptyState("main");
	file.findings.a = makeFinding("a");
	file.findings.b = makeFinding("b", {
		severity: "nit",
		file: "src/z.ts",
		present: false,
		decision: "ignore",
	});
	file.order = ["a", "b"];

	test("Finding expõe o estado e aplica updates", () => {
		const state = makeFinding("x");
		const finding = Finding.from(state);
		expect(finding.id).toBe("x");
		expect(finding.isDone).toBe(false);
		expect(finding.toJSON()).toBe(state);

		finding.apply({ decision: "execute", execState: "in_progress" }, "agora");
		expect(finding.decision).toBe("execute");
		expect(finding.execState).toBe("in_progress");
		expect(state.updatedAt).toBe("agora");
		expect(state.history).toHaveLength(1);
	});

	test("FindingsState lista, filtra e resume", () => {
		const state = FindingsState.from(file);
		expect(state.branch).toBe("main");
		expect(state.list().map((f) => f.id)).toEqual(["a", "b"]);
		expect(state.get("a")?.file).toBe("src/a.ts");
		expect(state.get("missing")).toBeNull();
		expect(state.present().map((f) => f.id)).toEqual(["a"]);
		expect(state.filter({ severity: "nit", includeAbsent: true })).toHaveLength(1);
		expect(state.summarize().total).toBe(2);
		expect(state.summarize().present).toBe(1);
		expect(state.toJSON()).toBe(file);
	});

	test("FindingsState aplica updates e delega sync/reorder", () => {
		const state = FindingsState.from(emptyState("main"));
		state.file.findings.a = makeFinding("a");
		state.file.order = ["a"];

		expect(state.apply("missing", { decision: "ignore" })).toBeNull();
		const updated = state.apply("a", { decision: "execute" }, "agora");
		expect(updated?.decision).toBe("execute");
		expect(state.file.findings.a?.updatedAt).toBe("agora");

		const result = state.sync(() => null);
		expect(result.stale).toEqual(["a"]);
	});

	test("FindingsState.empty cria uma coleção vazia válida", () => {
		const empty = FindingsState.empty("feature/x");
		expect(empty.branch).toBe("feature/x");
		expect(empty.list()).toEqual([]);
		expect(empty.summarize().total).toBe(0);
	});
});
