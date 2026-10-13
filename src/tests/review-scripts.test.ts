import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiosInstance } from "axios";
import { renderBrief } from "../core/brief";
import { parseReviewArgs } from "../core/commands/review";
import { renderWatchdogContext } from "../core/commands/watchdog";
import {
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAX_FILES_PER_BRIEF,
	resolveJevConcurrency,
	resolveMaxFilesPerBrief,
} from "../core/config";
import { parseDiffIndex, parseNumstat } from "../core/diff-source";
import { discoverDocs } from "../core/doc-discoverer";
import {
	type ClassificationResult,
	churnOf,
	classifyEntries,
	isExcludedPath,
	matchWatchdogs,
	parseEntries,
	selectByBudget,
	sortByRisk,
} from "../core/file-classifier";
import {
	type JevCandidatesFile,
	JevCandidatesStore,
	JevClient,
	JevDetector,
	JevError,
	JevQuestionFactory,
} from "../core/jev";
import { checkRegistry } from "../core/registry-check";
import {
	dedupeFindings,
	parseContextSummary,
	parseWatchdogReport,
	renderDomainReport,
	renderReport,
	sanitizeBranch,
	type WatchdogReport,
} from "../core/report-builder";
import type { WatchdogMeta } from "../core/types";
import { defineWatchdog } from "../core/types";
import { findWatchdog, getWatchdogContext } from "../core/watchdog-registry";

import {
	alphaWatchdog,
	FAKE_WATCHDOG_DEFINITIONS,
	fakeHoundsmanConfig,
} from "./fixtures/fake-project";

/** Registry do projeto fake, para injetar nos helpers genéricos. */
const REGISTRY = FAKE_WATCHDOG_DEFINITIONS as Record<string, WatchdogMeta>;

// ---------------------------------------------------------------------------
// Config / registry
// ---------------------------------------------------------------------------

describe("config", () => {
	test("deriva watchdogIds das chaves de watchdogs", () => {
		expect(fakeHoundsmanConfig.watchdogIds).toEqual(["alpha", "beta"]);
	});

	test("todo watchdog tem metadados completos", () => {
		for (const id of fakeHoundsmanConfig.watchdogIds) {
			const def = fakeHoundsmanConfig.watchdogs[id];
			expect(def.name.length).toBeGreaterThan(0);
			expect(def.scope.length).toBeGreaterThan(0);
			expect(def.rules.length).toBeGreaterThan(0);
			expect(def.classify?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("findWatchdog resolve por id e devolve null p/ inexistente", () => {
		expect(findWatchdog(fakeHoundsmanConfig, "alpha")?.name).toBe("Alpha");
		expect(findWatchdog(fakeHoundsmanConfig, "nao-existe")).toBeNull();
	});

	test("getWatchdogContext expõe metadados sem regras", () => {
		const ctx = getWatchdogContext(fakeHoundsmanConfig, "beta");
		expect(ctx.id).toBe("beta");
		expect(ctx.contextFiles).toContain("README.md");
		expect("rules" in ctx).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkRegistry (anti-drift) — roda sobre o project fake
// ---------------------------------------------------------------------------

describe("registry-check", () => {
	test("config fake é consistente (0 problemas)", () => {
		const { problems } = checkRegistry(fakeHoundsmanConfig);
		expect(problems).toEqual([]);
	});

	test("falha quando um watchdog não declara 'classify'", () => {
		const broken = { ...alphaWatchdog, classify: undefined };
		const config = {
			...fakeHoundsmanConfig,
			watchdogs: { ...fakeHoundsmanConfig.watchdogs, alpha: broken },
		};
		const { problems } = checkRegistry(config as typeof fakeHoundsmanConfig);
		expect(problems.some((p) => p.includes("'alpha'"))).toBe(true);
	});

	test("regra sem polaridade explícita gera aviso (não problema)", () => {
		const { problems, warnings } = checkRegistry(fakeHoundsmanConfig);
		expect(problems).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("polaridade"))).toBe(true);
	});

	test("regras com 'Promover:'/'Evitar:'/'Não'/'Nunca' não geram aviso", () => {
		const config = {
			...fakeHoundsmanConfig,
			watchdogs: {
				...fakeHoundsmanConfig.watchdogs,
				alpha: {
					...alphaWatchdog,
					rules: [
						{
							severity: "blocking" as const,
							text: "Promover: validar a entrada.",
						},
						{ severity: "attention" as const, text: "Evitar console.log." },
						{
							severity: "nit" as const,
							text: "Não acessar o banco em rotas.",
						},
						{ severity: "nit" as const, text: "Nunca usar `any`." },
					],
				},
			},
		};
		const { warnings } = checkRegistry(config as typeof fakeHoundsmanConfig);
		expect(warnings).toEqual([]);
	});

	test("regra duplicada no mesmo watchdog gera aviso", () => {
		const config = {
			...fakeHoundsmanConfig,
			watchdogs: {
				...fakeHoundsmanConfig.watchdogs,
				alpha: {
					...alphaWatchdog,
					rules: [
						{ severity: "attention" as const, text: "Evitar console.log." },
						{ severity: "blocking" as const, text: "Evitar   console.log." },
					],
				},
			},
		};
		const { warnings } = checkRegistry(config as typeof fakeHoundsmanConfig);
		expect(warnings.some((w) => w.includes("duplicada"))).toBe(true);
	});

	test("texto de regra em reviewFocus/contextFiles gera aviso", () => {
		const config = {
			...fakeHoundsmanConfig,
			watchdogs: {
				...fakeHoundsmanConfig.watchdogs,
				alpha: {
					...alphaWatchdog,
					reviewFocus: ["Evitar: console.log."],
					contextFiles: ["Promover: validar a entrada."],
				},
			},
		};
		const { warnings } = checkRegistry(config as typeof fakeHoundsmanConfig);
		expect(
			warnings.filter((w) => w.includes("a regra vive só em 'rules'")),
		).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// file-classifier
// ---------------------------------------------------------------------------

describe("parseEntries", () => {
	test("parseia name-status com A/M/D/R", () => {
		const raw = [
			"A\tsrc/new.ts",
			"M\tsrc/mod.ts",
			"D\tsrc/old.ts",
			"R100\tsrc/before.ts\tsrc/after.ts",
		].join("\n");

		const entries = parseEntries(raw);
		expect(entries).toHaveLength(4);
		expect(entries[0]).toEqual({ path: "src/new.ts", status: "added" });
		expect(entries[1]).toEqual({ path: "src/mod.ts", status: "modified" });
		expect(entries[2]).toEqual({ path: "src/old.ts", status: "deleted" });
		expect(entries[3]).toEqual({
			path: "src/after.ts",
			oldPath: "src/before.ts",
			status: "renamed",
		});
	});

	test("parseia caminhos sem status como modified", () => {
		const entries = parseEntries("src/a.ts\nsrc/b.ts");
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({ path: "src/a.ts", status: "modified" });
	});
});

describe("matchWatchdogs", () => {
	test("une os watchdogs cujo classify casa", () => {
		expect(
			matchWatchdogs(
				"src/alpha/x.ts",
				fakeHoundsmanConfig.watchdogs,
				fakeHoundsmanConfig.watchdogIds,
			),
		).toEqual(["alpha"]);
	});

	test("casa por padrão de nome de arquivo (sem casar sufixos)", () => {
		expect(
			matchWatchdogs(
				"lib/special.ts",
				fakeHoundsmanConfig.watchdogs,
				fakeHoundsmanConfig.watchdogIds,
			),
		).toEqual(["beta"]);
		expect(
			matchWatchdogs(
				"lib/special-extra.ts",
				fakeHoundsmanConfig.watchdogs,
				fakeHoundsmanConfig.watchdogIds,
			),
		).toEqual([]);
	});

	test("casa pelo conteúdo do arquivo quando type é 'content'", () => {
		const probe = defineWatchdog({
			id: "probe",
			name: "Probe",
			description: "Watchdog por conteúdo.",
			scope: "qualquer arquivo",
			classify: [{ type: "content", value: "NEEDLE" }],
			rules: [],
			contextFiles: [],
		});
		const watchdogs = { probe };

		expect(matchWatchdogs("any/file.ts", watchdogs, ["probe"], "// NEEDLE")).toEqual([
			"probe",
		]);
		expect(matchWatchdogs("any/file.ts", watchdogs, ["probe"], "sem alvo")).toEqual(
			[],
		);
		// Sem conteúdo (arquivo não lido) a regra de conteúdo não casa.
		expect(matchWatchdogs("any/file.ts", watchdogs, ["probe"])).toEqual([]);
	});

	test("arquivo sem padrão não casa nenhum watchdog", () => {
		expect(
			matchWatchdogs(
				"scripts/foo.ts",
				fakeHoundsmanConfig.watchdogs,
				fakeHoundsmanConfig.watchdogIds,
			),
		).toEqual([]);
	});
});

describe("classifyEntries", () => {
	test("atribui ao watchdog dono do padrão", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/alpha/x.ts"),
			fakeHoundsmanConfig,
		);
		expect(result.watchdogs.alpha).toEqual(["src/alpha/x.ts"]);
	});

	test("arquivo de teste casa o watchdog de testes", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/beta/x.test.ts"),
			fakeHoundsmanConfig,
		);
		expect(result.watchdogs.beta).toEqual(["src/beta/x.test.ts"]);
	});

	test("arquivo sem match fica unclassified (sem fallback)", () => {
		const scripts = classifyEntries(
			parseEntries("M\tscripts/foo.ts"),
			fakeHoundsmanConfig,
		);
		expect(scripts.unclassified).toEqual(["scripts/foo.ts"]);

		const gamma = classifyEntries(
			parseEntries("M\tsrc/gamma/x.ts"),
			fakeHoundsmanConfig,
		);
		expect(gamma.unclassified).toEqual(["src/gamma/x.ts"]);
	});

	test("casa por padrão de nome de arquivo", () => {
		const hit = classifyEntries(
			parseEntries("M\tlib/special.ts"),
			fakeHoundsmanConfig,
		);
		expect(hit.watchdogs.beta).toEqual(["lib/special.ts"]);

		const miss = classifyEntries(
			parseEntries("M\tlib/special-extra.ts"),
			fakeHoundsmanConfig,
		);
		expect(miss.unclassified).toEqual(["lib/special-extra.ts"]);
	});

	test("excluídos não entram em watchdogs", () => {
		const result = classifyEntries(
			parseEntries("M\tdist/x.js\nM\tsrc/alpha/y.ts"),
			fakeHoundsmanConfig,
		);
		expect(result.excluded).toEqual(["dist/x.js"]);
		expect(result.watchdogs.alpha).toEqual(["src/alpha/y.ts"]);
	});

	test("deletados não entram em watchdogs mas ficam em deleted", () => {
		const result = classifyEntries(
			parseEntries("D\tsrc/alpha/old.ts"),
			fakeHoundsmanConfig,
		);
		expect(result.deleted).toEqual(["src/alpha/old.ts"]);
		expect(result.watchdogs.alpha).toBeUndefined();
		expect(result.files["src/alpha/old.ts"]).toEqual({ status: "deleted" });
	});

	test("stats refletem o número de arquivos por watchdog", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/alpha/a.ts\nM\tsrc/alpha/b.ts"),
			fakeHoundsmanConfig,
		);
		expect(result.stats.alpha).toBe(2);
	});
});

describe("isExcludedPath", () => {
	test("casa os padrões de exclusão", () => {
		expect(isExcludedPath("dist/x.js", fakeHoundsmanConfig.exclusions)).toBe(true);
		expect(isExcludedPath("bun.lock", fakeHoundsmanConfig.exclusions)).toBe(true);
		expect(isExcludedPath("src/alpha/x.ts", fakeHoundsmanConfig.exclusions)).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// diff-source (diff único: patch + churn)
// ---------------------------------------------------------------------------

describe("diff-source", () => {
	test("parseNumstat lê adições/remoções por arquivo", () => {
		const map = parseNumstat("3\t1\tsrc/a.ts\0");
		expect(map.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
	});

	test("parseNumstat trata rename (path vazio) e binário ('-')", () => {
		const nul = String.fromCharCode(0);
		const raw = [
			"2	0	",
			"src/old.ts",
			"src/new.ts",
			"10	-	dist/x.png",
			"",
		].join(nul);
		const map = parseNumstat(raw);
		expect(map.get("src/new.ts")).toEqual({ additions: 2, deletions: 0 });
		expect(map.get("dist/x.png")).toEqual({ additions: 10, deletions: 0 });
	});

	test("parseDiffIndex fatia o patch e extrai o path novo (renames)", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/src/old.ts b/src/new.ts",
			"similarity index 90%",
			"rename from src/old.ts",
			"rename to src/new.ts",
			"--- a/src/old.ts",
			"+++ b/src/new.ts",
			"@@ -1 +1 @@",
			"-a",
			"+b",
		].join("\n");

		const map = parseDiffIndex(patch);
		expect([...map.keys()]).toEqual(["src/a.ts", "src/new.ts"]);
		expect(map.get("src/a.ts")).toContain("+new");
		expect(map.get("src/new.ts")).toContain("+b");
	});

	test("parseDiffIndex não confunde linha de conteúdo com o header", () => {
		const patch = [
			"diff --git a/x.ts b/x.ts",
			"--- a/x.ts",
			"+++ b/x.ts",
			"@@ -1 +1,2 @@",
			" keep",
			"+++ b/fake.ts",
		].join("\n");
		expect([...parseDiffIndex(patch).keys()]).toEqual(["x.ts"]);
	});

	test("parseDiffIndex respeita o teto por arquivo", () => {
		const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+a";
		expect(parseDiffIndex(patch, 10).get("x.ts")).toHaveLength(10);
	});
});

// ---------------------------------------------------------------------------
// triage (churn + orçamento por brief)
// ---------------------------------------------------------------------------

describe("triage", () => {
	const churn = {
		"a.ts": { additions: 1, deletions: 0 },
		"b.ts": { additions: 50, deletions: 50 },
		"c.ts": { additions: 10, deletions: 0 },
	};

	test("churnOf soma adições/remoções e trata ausente", () => {
		expect(churnOf("b.ts", churn)).toBe(100);
		expect(churnOf("ausente.ts", churn)).toBe(0);
	});

	test("sortByRisk ordena por churn desc", () => {
		expect(sortByRisk(["a.ts", "b.ts", "c.ts"], churn)).toEqual([
			"b.ts",
			"c.ts",
			"a.ts",
		]);
	});

	test("selectByBudget mantém os de maior risco e devolve o excedente", () => {
		const { selected, overflow } = selectByBudget(["a.ts", "b.ts", "c.ts"], churn, 2);
		expect(selected).toEqual(["b.ts", "c.ts"]);
		expect(overflow).toEqual(["a.ts"]);
	});

	test("maxFiles não-positivo desativa o orçamento", () => {
		const { selected, overflow } = selectByBudget(["a.ts", "b.ts"], churn, 0);
		expect(selected).toHaveLength(2);
		expect(overflow).toEqual([]);
	});

	test("resolveMaxFilesPerBrief usa default e sobrepõe", () => {
		expect(resolveMaxFilesPerBrief(fakeHoundsmanConfig)).toBe(
			DEFAULT_MAX_FILES_PER_BRIEF,
		);
		expect(
			resolveMaxFilesPerBrief({
				...fakeHoundsmanConfig,
				budgets: { maxFilesPerBrief: 5 },
			}),
		).toBe(5);
		expect(
			resolveMaxFilesPerBrief({
				...fakeHoundsmanConfig,
				budgets: { maxFilesPerBrief: 0 },
			}),
		).toBe(DEFAULT_MAX_FILES_PER_BRIEF);
	});

	test("resolveJevConcurrency usa default e sobrepõe", () => {
		expect(resolveJevConcurrency(fakeHoundsmanConfig)).toBe(DEFAULT_JEV_CONCURRENCY);
		expect(
			resolveJevConcurrency({ ...fakeHoundsmanConfig, concurrency: { jev: 9 } }),
		).toBe(9);
	});
});

// ---------------------------------------------------------------------------
// doc-discoverer
// ---------------------------------------------------------------------------

describe("discoverDocs", () => {
	test("sempre inclui os docs de alwaysIncludeDocs", () => {
		expect(discoverDocs(["src/alpha/x.ts"], fakeHoundsmanConfig)).toContain(
			"README.md",
		);
	});

	test("aplica os docMappings do projeto", () => {
		expect(discoverDocs(["src/beta/y.ts"], fakeHoundsmanConfig)).toContain(
			"README.md",
		);
	});
});

// ---------------------------------------------------------------------------
// report-builder
// ---------------------------------------------------------------------------

describe("report-builder", () => {
	test("sanitizeBranch substitui barras", () => {
		expect(sanitizeBranch("feature/add-webhook")).toBe("feature-add-webhook");
		expect(sanitizeBranch("Feature/Add")).toBe("feature-add");
		expect(sanitizeBranch("main")).toBe("main");
	});

	test("parseWatchdogReport rejeita severidade inválida", () => {
		const report = parseWatchdogReport(
			{
				watchdogId: "alpha",
				findings: [
					{
						rule: "x",
						severity: "critical",
						file: "a.ts",
						message: "m",
						action: "a",
					},
				],
			},
			"test",
		);
		expect(report?.findings).toHaveLength(0);
	});

	test("dedupeFindings mescla watchdogs e mantém a severidade mais grave", () => {
		const reports: WatchdogReport[] = [
			{
				watchdogId: "alpha",
				reviewedFiles: ["a.ts"],
				skipped: [],
				findings: [
					{
						rule: "Regra compartilhada",
						severity: "attention",
						file: "a.ts",
						line: 10,
						message: "menor",
						action: "a",
					},
				],
			},
			{
				watchdogId: "beta",
				reviewedFiles: ["a.ts"],
				skipped: [],
				findings: [
					{
						rule: "Regra compartilhada",
						severity: "blocking",
						file: "a.ts",
						line: 10,
						message: "maior",
						action: "a",
					},
				],
			},
		];

		const merged = dedupeFindings(reports);
		expect(merged).toHaveLength(1);
		expect(merged[0].watchdogs).toHaveLength(2);
		expect(merged[0].severity).toBe("blocking");
		expect(merged[0].message).toBe("maior");
	});

	test("renderReport marca status conforme severidade", () => {
		const reports: WatchdogReport[] = [
			{ watchdogId: "alpha", reviewedFiles: ["s.ts"], skipped: [], findings: [] },
		];

		expect(renderReport("main", reports, [], {})).toContain("✅ Aprovado");

		const blockers = renderReport(
			"main",
			reports,
			[
				{
					rule: "Regra bloqueante",
					severity: "blocking",
					file: "s.ts",
					message: "m",
					action: "a",
					watchdogs: ["alpha"],
				},
			],
			{},
		);
		expect(blockers).toContain("❌ Mudanças Necessárias");
		expect(blockers).toContain("## ❌ blocking");
	});

	test("renderReport mostra cobertura pendente", () => {
		const reports: WatchdogReport[] = [
			{ watchdogId: "alpha", reviewedFiles: ["s.ts"], skipped: [], findings: [] },
		];
		const md = renderReport("main", reports, [], {
			classified: { alpha: ["s.ts", "t.ts"] },
		});
		expect(md).toContain("faltam 1");
	});

	test("renderReport usa o resolver de nome injetado", () => {
		const reports: WatchdogReport[] = [
			{ watchdogId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
		];
		const md = renderReport("main", reports, [], {}, undefined, undefined, (id) =>
			id === "alpha" ? "Watchdog Alpha" : id,
		);
		expect(md).toContain("Watchdog Alpha");
	});

	test("renderReport agrupa achados por arquivo", () => {
		const merged = [
			{
				rule: "R1",
				severity: "blocking" as const,
				file: "a.ts",
				line: 1,
				message: "m",
				action: "a",
				watchdogs: ["alpha"],
			},
			{
				rule: "R2",
				severity: "blocking" as const,
				file: "b.ts",
				line: 2,
				message: "m",
				action: "a",
				watchdogs: ["alpha"],
			},
		];
		const md = renderReport(
			"main",
			[{ watchdogId: "alpha", reviewedFiles: [], skipped: [], findings: [] }],
			merged,
			{},
		);
		expect(md).toContain("### `a.ts`");
		expect(md).toContain("### `b.ts`");
	});

	test("renderReport indexa os relatórios por domínio", () => {
		const md = renderReport(
			"main",
			[{ watchdogId: "alpha", reviewedFiles: [], skipped: [], findings: [] }],
			[],
			{},
			undefined,
			undefined,
			undefined,
			[
				{
					id: "alpha",
					name: "Alpha",
					file: "review.alpha.md",
					findings: 2,
					reviewedFiles: 3,
					expectedFiles: 5,
				},
			],
		);
		expect(md).toContain("## Relatórios por domínio");
		expect(md).toContain("review.alpha.md");
	});

	test("renderDomainReport mostra cobertura e não revisados", () => {
		const md = renderDomainReport(
			"main",
			{
				watchdogId: "alpha",
				reviewedFiles: ["a.ts"],
				skipped: ["b.ts"],
				findings: [],
			},
			[],
			2,
			null,
		);
		expect(md).toContain("1/2");
		expect(md).toContain("Não revisados");
		expect(md).toContain("Nenhum achado");
	});
});

// ---------------------------------------------------------------------------
// context-summary (contexto da PR)
// ---------------------------------------------------------------------------

describe("context-summary", () => {
	test("parseContextSummary aceita resumo válido", () => {
		const summary = parseContextSummary({
			available: true,
			source: { number: 12, title: "T", url: "u", base: "main", head: "f/x" },
			objective: "Fazer algo",
			motivation: "Porque sim",
			changeSummary: ["a", "", "b"],
		});
		expect(summary?.objective).toBe("Fazer algo");
		expect(summary?.changeSummary).toEqual(["a", "b"]);
		expect(summary?.source?.number).toBe(12);
	});

	test("parseContextSummary rejeita indisponível ou vazio", () => {
		expect(parseContextSummary({ available: false })).toBeNull();
		expect(parseContextSummary({ available: true })).toBeNull();
		expect(parseContextSummary(null)).toBeNull();
	});

	test("parseContextSummary enxuga resumo longo", () => {
		const summary = parseContextSummary({
			available: true,
			objective: "x".repeat(500),
			motivation: "y".repeat(500),
			changeSummary: Array.from(
				{ length: 10 },
				(_, i) => `item ${i} ${"z".repeat(300)}`,
			),
		});
		expect(summary?.objective?.length).toBeLessThanOrEqual(200);
		expect(summary?.objective?.endsWith("…")).toBe(true);
		expect(summary?.changeSummary).toHaveLength(4);
	});

	test("renderReport coloca a seção de contexto quando presente", () => {
		const reports: WatchdogReport[] = [
			{ watchdogId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
		];
		const md = renderReport(
			"main",
			reports,
			[],
			{},
			{
				available: true,
				objective: "Entregar X",
				motivation: "Reduzir Y",
				changeSummary: ["Faz A"],
			},
		);
		expect(md).toContain("## Contexto da PR");
		expect(md).toContain("**Objetivo:** Entregar X");
	});

	test("renderReport omite a seção sem contexto", () => {
		const reports: WatchdogReport[] = [
			{ watchdogId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
		];
		expect(renderReport("main", reports, [], {}, null)).not.toContain(
			"## Contexto da PR",
		);
	});
});

// ---------------------------------------------------------------------------
// brief
// ---------------------------------------------------------------------------

describe("houndsman brief", () => {
	const OUTPUT_FORMAT = ".houndsman/core/skill/OUTPUT-FORMAT.md";

	test("inclui regras, arquivos e output do watchdog", () => {
		const brief = renderBrief(alphaWatchdog, {
			watchdogId: "alpha",
			files: ["src/alpha/x.ts"],
			branch: "feature/x",
			outputPath: "tmp/fake-review/feature-x/findings/alpha.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: ["README.md"],
			statuses: { "src/alpha/x.ts": { status: "modified" } },
			deleted: [],
		});
		expect(brief).toContain("alpha");
		expect(brief).toContain("findings/alpha.json");
		expect(brief).toContain("Nunca usar `any`");
		expect(brief).toContain("Arquivos do seu domínio (1)");
	});

	test("seção Deletados aparece só com `breakingChange`", () => {
		const args = {
			watchdogId: "alpha",
			files: [],
			branch: "main",
			outputPath: "o.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: [],
			statuses: {},
			deleted: ["src/alpha/old.ts"],
		};
		const breakingDef = { ...alphaWatchdog, breakingChange: true };
		expect(renderBrief(breakingDef, args)).toContain("Deletados");
		expect(renderBrief(alphaWatchdog, args)).not.toContain("Deletados");
	});

	test("injeta o contexto da PR quando presente", () => {
		const brief = renderBrief(alphaWatchdog, {
			watchdogId: "alpha",
			files: ["a.ts"],
			branch: "feature/x",
			outputPath: "o.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: [],
			statuses: {},
			deleted: [],
			context: {
				objective: "Entregar X",
				motivation: "Reduzir Y",
				changeSummary: ["Faz A"],
			},
		});
		expect(brief).toContain("## Contexto da PR");
		expect(brief).toContain("**Objetivo:** Entregar X");
	});

	test("mostra churn e lista arquivos fora do orçamento", () => {
		const brief = renderBrief(alphaWatchdog, {
			watchdogId: "alpha",
			files: ["src/alpha/keep.ts"],
			overflow: ["src/alpha/skip.ts"],
			churn: { "src/alpha/keep.ts": { additions: 12, deletions: 3 } },
			branch: "feature/x",
			outputPath: "o.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: [],
			statuses: { "src/alpha/keep.ts": { status: "modified" } },
			deleted: [],
		});
		expect(brief).toContain("+12/−3");
		expect(brief).toContain("Fora do orçamento");
		expect(brief).toContain("src/alpha/skip.ts");
	});

	test("hook custom de renderBrief é usado no lugar do default", () => {
		const custom = { ...alphaWatchdog, renderBrief: () => ["# Custom"] };
		const brief = renderBrief(custom, {
			watchdogId: "alpha",
			files: [],
			branch: "main",
			outputPath: "o.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: [],
			statuses: {},
			deleted: [],
		});
		expect(brief).toBe("# Custom");
	});
});

// ---------------------------------------------------------------------------
// Jev — perguntas derivadas
// ---------------------------------------------------------------------------

describe("jev-questions", () => {
	const factory = new JevQuestionFactory(REGISTRY);

	test("spec noul sem instructions cita a regra", () => {
		const q = factory.fromSpec("Regra X", { kind: "noul" });
		expect(q?.type).toBe("noul");
		expect(JSON.stringify(q)).toContain("Regra X");
	});

	test("instructions customizada é preservada", () => {
		const q = factory.fromSpec("Regra X", {
			kind: "noul",
			instructions: "A pergunta customizada?",
		});
		expect(q).toEqual({ type: "noul", instructions: "A pergunta customizada?" });
	});

	test("choice exige criteria em objeto (senão null)", () => {
		expect(factory.fromSpec("r", { kind: "choice" })).toBeNull();
		expect(factory.fromSpec("r", { kind: "choice", criteria: {} })).toBeNull();
		expect(factory.fromSpec("r", { kind: "choice", criteria: [] })).toBeNull();
		expect(
			factory.fromSpec("r", { kind: "choice", criteria: { a: "A" } }),
		).toMatchObject({
			type: "choice",
		});
	});

	test("score exige array de critérios (senão null)", () => {
		expect(factory.fromSpec("r", { kind: "score", criteria: [] })).toBeNull();
		expect(factory.fromSpec("r", { kind: "score", criteria: ["a"] })).toMatchObject({
			type: "score",
		});
	});

	test("derive só emite regras com spec e preserva a descrição", () => {
		const derived = factory.derive("alpha");
		expect(derived.length).toBeGreaterThan(0);
		for (const d of derived) {
			expect(d.key.startsWith("alpha::")).toBe(true);
			expect(d.rule.length).toBeGreaterThan(0);
			expect(d.question.instructions.length).toBeGreaterThan(0);
		}
	});

	test("derive de id desconhecido devolve vazio", () => {
		expect(factory.derive("nao-existe")).toEqual([]);
	});

	test("build agrega watchdogs sem chaves duplicadas", () => {
		const all = factory.build(["alpha", "beta"]);
		const keys = all.map((q) => q.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

// ---------------------------------------------------------------------------
// Jev — cliente axios
// ---------------------------------------------------------------------------

describe("jev-client", () => {
	test("isConfigured reflete a chave", () => {
		expect(new JevClient({ apiKey: "" }).isConfigured()).toBe(false);
		expect(new JevClient({ apiKey: "k" }).isConfigured()).toBe(true);
	});

	test("evaluate exige chave", async () => {
		const client = new JevClient({ apiKey: "" });
		await expect(
			client.evaluate({ state: "s", questions: {} }),
		).rejects.toBeInstanceOf(JevError);
	});

	test("evaluate posta e retorna a resposta tipada", async () => {
		let captured: { model?: string } | undefined;
		const http = {
			post: async (_url: string, body: { model?: string }) => {
				captured = body;
				return { data: { model: "jev-test", answers: {} } };
			},
		} as unknown as AxiosInstance;
		const client = new JevClient({ apiKey: "k", model: "jev-x", http });
		const res = await client.evaluate({ state: "s", questions: {} });
		expect(res.model).toBe("jev-test");
		expect(captured?.model).toBe("jev-x");
	});

	test("erro HTTP vira JevError", async () => {
		const http = {
			post: async () => {
				throw new Error("boom");
			},
		} as unknown as AxiosInstance;
		const client = new JevClient({ apiKey: "k", http });
		await expect(
			client.evaluate({ state: "s", questions: {} }),
		).rejects.toBeInstanceOf(JevError);
	});
});

describe("jev-client — validateCredential", () => {
	/** Erro no formato do axios (isAxiosError + response.status). */
	function axiosError(status: number): Error {
		return Object.assign(new Error(`HTTP ${status}`), {
			isAxiosError: true,
			response: { status, data: "unauthorized" },
		});
	}

	test("sem chave → unreachable e não faz chamada", async () => {
		let called = false;
		const http = {
			post: async () => {
				called = true;
				return { data: { model: "x", answers: {} } };
			},
		} as unknown as AxiosInstance;
		const check = await new JevClient({ apiKey: "", http }).validateCredential();
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.kind).toBe("unreachable");
		expect(called).toBe(false);
	});

	test("2xx → credencial válida com o modelo", async () => {
		const http = {
			post: async () => ({ data: { model: "jev-test", answers: {} } }),
		} as unknown as AxiosInstance;
		const check = await new JevClient({ apiKey: "k", http }).validateCredential();
		expect(check).toEqual({ ok: true, model: "jev-test" });
	});

	test("401 → credencial inválida", async () => {
		const http = {
			post: async () => {
				throw axiosError(401);
			},
		} as unknown as AxiosInstance;
		const check = await new JevClient({ apiKey: "k", http }).validateCredential();
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.kind).toBe("invalid");
	});

	test("falha de rede → indeterminada (unreachable)", async () => {
		const http = {
			post: async () => {
				throw new Error("network down");
			},
		} as unknown as AxiosInstance;
		const check = await new JevClient({ apiKey: "k", http }).validateCredential();
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.kind).toBe("unreachable");
	});

	test("evaluate preserva o status HTTP no JevError", async () => {
		const http = {
			post: async () => {
				throw axiosError(403);
			},
		} as unknown as AxiosInstance;
		const client = new JevClient({ apiKey: "k", http });
		await expect(
			client.evaluate({ state: "s", questions: {} }),
		).rejects.toMatchObject({ status: 403 });
	});
});

// ---------------------------------------------------------------------------
// Jev — detector (fail-open)
// ---------------------------------------------------------------------------

describe("jev-detector", () => {
	const classification: ClassificationResult = {
		watchdogs: { alpha: ["src/alpha/x.ts"] },
		files: { "src/alpha/x.ts": { status: "modified" } },
		churn: {},
		unclassified: [],
		excluded: [],
		deleted: [],
		stats: {},
		excludedCount: 0,
	};

	function stubClient(noul: number): JevClient {
		return {
			evaluate: async (req: { questions: Record<string, unknown> }) => {
				const answers: Record<string, unknown> = {};
				for (const key of Object.keys(req.questions))
					answers[key] = { type: "noul", noul };
				return { model: "jev-stub", answers };
			},
		} as unknown as JevClient;
	}

	test("gera candidatos acima do limiar", async () => {
		const result = await new JevDetector(stubClient(0.9), REGISTRY).detect(
			classification,
			"main",
			"HEAD",
		);
		expect(result.candidates.length).toBeGreaterThan(0);
		for (const c of result.candidates) {
			expect(c.confidence).toBe(0.9);
			expect(c.file).toBe("src/alpha/x.ts");
		}
	});

	test("ignora respostas abaixo do limiar", async () => {
		const result = await new JevDetector(stubClient(0.1), REGISTRY).detect(
			classification,
			"main",
			"HEAD",
		);
		expect(result.candidates).toHaveLength(0);
		expect(result.analyzedFiles).toBe(1);
	});

	test("falha por arquivo vira skipped (fail-open)", async () => {
		const failing = {
			evaluate: async () => {
				throw new Error("timeout");
			},
		} as unknown as JevClient;
		const result = await new JevDetector(failing, REGISTRY).detect(
			classification,
			"main",
			"HEAD",
		);
		expect(result.candidates).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toContain("timeout");
	});
});

// ---------------------------------------------------------------------------
// Jev — artefato de candidatos
// ---------------------------------------------------------------------------

describe("jev-candidates", () => {
	test("round-trip de candidates.json", () => {
		const file = join(tmpdir(), `jev-cand-${Date.now()}.json`);
		const data: JevCandidatesFile = {
			available: true,
			model: "jev-test",
			threshold: JevCandidatesStore.THRESHOLD,
			analyzedFiles: 1,
			candidates: [
				{
					watchdogId: "alpha",
					rule: "R",
					severity: "blocking",
					file: "a.ts",
					confidence: 0.8,
					questionKey: "alpha::anti-0",
				},
			],
		};
		try {
			new JevCandidatesStore(file, fakeHoundsmanConfig.watchdogIds).write(data);
			const read = new JevCandidatesStore(
				file,
				fakeHoundsmanConfig.watchdogIds,
			).read();
			expect(read?.available).toBe(true);
			expect(read?.candidates).toHaveLength(1);
			expect(read?.candidates[0].rule).toBe("R");
		} finally {
			rmSync(file, { force: true });
		}
	});

	test("read retorna null para arquivo ausente", () => {
		const store = new JevCandidatesStore(
			join(tmpdir(), `missing-${Date.now()}.json`),
			fakeHoundsmanConfig.watchdogIds,
		);
		expect(store.read()).toBeNull();
	});

	test("unavailable marca indisponível e sem candidatos", () => {
		const empty = JevCandidatesStore.unavailable("sem chave");
		expect(empty.available).toBe(false);
		expect(empty.candidates).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe("parseReviewArgs", () => {
	test("lê flags de valor e booleanas", () => {
		const opts = parseReviewArgs(
			["--base", "develop", "--branch", "feature/x", "--finalize", "--clean"],
			"tmp/artifacts",
		);
		expect(opts.base).toBe("develop");
		expect(opts.branch).toBe("feature/x");
		expect(opts.dir).toBe("tmp/artifacts");
		expect(opts.finalize).toBe(true);
		expect(opts.clean).toBe(true);
		expect(opts.failOnBlocking).toBe(false);
	});
});

describe("renderWatchdogContext", () => {
	test("markdown inclui nome e escopo", () => {
		const md = renderWatchdogContext(fakeHoundsmanConfig, "alpha");
		expect(md).toContain("# Alpha");
		expect(md).toContain("**Escopo:**");
	});

	test("json inclui id; com --rules inclui regras", () => {
		const json = renderWatchdogContext(fakeHoundsmanConfig, "alpha", {
			json: true,
			withRules: true,
		});
		const parsed = JSON.parse(json ?? "{}");
		expect(parsed.id).toBe("alpha");
		expect(parsed.rules).toBeDefined();
	});

	test("id inexistente devolve null", () => {
		expect(renderWatchdogContext(fakeHoundsmanConfig, "nao-existe")).toBeNull();
	});
});
