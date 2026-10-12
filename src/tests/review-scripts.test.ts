import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiosInstance } from "axios";
import { renderBrief } from "../core/brief";
import { parseReviewArgs } from "../core/commands/review";
import { renderReviewerContext } from "../core/commands/reviewer";
import { discoverDocs } from "../core/doc-discoverer";
import {
	type ClassificationResult,
	classifyEntries,
	isExcludedPath,
	matchReviewers,
	parseEntries,
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
	parseReviewerReport,
	type ReviewerReport,
	renderReport,
	sanitizeBranch,
} from "../core/report-builder";
import { findReviewer, getReviewerContext } from "../core/reviewer-registry";
import type { ReviewerMeta } from "../core/types";
import { defineReviewer } from "../core/types";

import {
	alphaReviewer,
	FAKE_REVIEWER_DEFINITIONS,
	fakeReviewConfig,
} from "./fixtures/fake-project";

/** Registry do projeto fake, para injetar nos helpers genéricos. */
const REGISTRY = FAKE_REVIEWER_DEFINITIONS as Record<string, ReviewerMeta>;

// ---------------------------------------------------------------------------
// Config / registry
// ---------------------------------------------------------------------------

describe("config", () => {
	test("deriva reviewerIds das chaves de reviewers", () => {
		expect(fakeReviewConfig.reviewerIds).toEqual(["alpha", "beta"]);
	});

	test("todo revisor tem metadados completos", () => {
		for (const id of fakeReviewConfig.reviewerIds) {
			const def = fakeReviewConfig.reviewers[id];
			expect(def.name.length).toBeGreaterThan(0);
			expect(def.scope.length).toBeGreaterThan(0);
			expect(def.rules.length).toBeGreaterThan(0);
			expect(def.classify?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("findReviewer resolve por id e devolve null p/ inexistente", () => {
		expect(findReviewer(fakeReviewConfig, "alpha")?.name).toBe("Alpha");
		expect(findReviewer(fakeReviewConfig, "nao-existe")).toBeNull();
	});

	test("getReviewerContext expõe metadados sem regras", () => {
		const ctx = getReviewerContext(fakeReviewConfig, "beta");
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
		const { problems } = checkRegistry(fakeReviewConfig);
		expect(problems).toEqual([]);
	});

	test("falha quando um revisor não declara 'classify'", () => {
		const broken = { ...alphaReviewer, classify: undefined };
		const config = {
			...fakeReviewConfig,
			reviewers: { ...fakeReviewConfig.reviewers, alpha: broken },
		};
		const { problems } = checkRegistry(config as typeof fakeReviewConfig);
		expect(problems.some((p) => p.includes("'alpha'"))).toBe(true);
	});

	test("regra sem polaridade explícita gera aviso (não problema)", () => {
		const { problems, warnings } = checkRegistry(fakeReviewConfig);
		expect(problems).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.includes("polaridade"))).toBe(true);
	});

	test("regras com 'Promover:'/'Evitar:'/'Não'/'Nunca' não geram aviso", () => {
		const config = {
			...fakeReviewConfig,
			reviewers: {
				...fakeReviewConfig.reviewers,
				alpha: {
					...alphaReviewer,
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
		const { warnings } = checkRegistry(config as typeof fakeReviewConfig);
		expect(warnings).toEqual([]);
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

describe("matchReviewers", () => {
	test("une os revisores cujo classify casa", () => {
		expect(
			matchReviewers(
				"src/alpha/x.ts",
				fakeReviewConfig.reviewers,
				fakeReviewConfig.reviewerIds,
			),
		).toEqual(["alpha"]);
	});

	test("casa por padrão de nome de arquivo (sem casar sufixos)", () => {
		expect(
			matchReviewers(
				"lib/special.ts",
				fakeReviewConfig.reviewers,
				fakeReviewConfig.reviewerIds,
			),
		).toEqual(["beta"]);
		expect(
			matchReviewers(
				"lib/special-extra.ts",
				fakeReviewConfig.reviewers,
				fakeReviewConfig.reviewerIds,
			),
		).toEqual([]);
	});

	test("casa pelo conteúdo do arquivo quando type é 'content'", () => {
		const probe = defineReviewer({
			id: "probe",
			name: "Probe",
			description: "Revisor por conteúdo.",
			scope: "qualquer arquivo",
			classify: [{ type: "content", value: "NEEDLE" }],
			rules: [],
			contextFiles: [],
		});
		const reviewers = { probe };

		expect(matchReviewers("any/file.ts", reviewers, ["probe"], "// NEEDLE")).toEqual([
			"probe",
		]);
		expect(matchReviewers("any/file.ts", reviewers, ["probe"], "sem alvo")).toEqual(
			[],
		);
		// Sem conteúdo (arquivo não lido) a regra de conteúdo não casa.
		expect(matchReviewers("any/file.ts", reviewers, ["probe"])).toEqual([]);
	});

	test("arquivo sem padrão não casa nenhum revisor", () => {
		expect(
			matchReviewers(
				"scripts/foo.ts",
				fakeReviewConfig.reviewers,
				fakeReviewConfig.reviewerIds,
			),
		).toEqual([]);
	});
});

describe("classifyEntries", () => {
	test("atribui ao revisor dono do padrão", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/alpha/x.ts"),
			fakeReviewConfig,
		);
		expect(result.reviewers.alpha).toEqual(["src/alpha/x.ts"]);
	});

	test("arquivo de teste casa o revisor de testes", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/beta/x.test.ts"),
			fakeReviewConfig,
		);
		expect(result.reviewers.beta).toEqual(["src/beta/x.test.ts"]);
	});

	test("arquivo sem match fica unclassified (sem fallback)", () => {
		const scripts = classifyEntries(
			parseEntries("M\tscripts/foo.ts"),
			fakeReviewConfig,
		);
		expect(scripts.unclassified).toEqual(["scripts/foo.ts"]);

		const gamma = classifyEntries(
			parseEntries("M\tsrc/gamma/x.ts"),
			fakeReviewConfig,
		);
		expect(gamma.unclassified).toEqual(["src/gamma/x.ts"]);
	});

	test("casa por padrão de nome de arquivo", () => {
		const hit = classifyEntries(parseEntries("M\tlib/special.ts"), fakeReviewConfig);
		expect(hit.reviewers.beta).toEqual(["lib/special.ts"]);

		const miss = classifyEntries(
			parseEntries("M\tlib/special-extra.ts"),
			fakeReviewConfig,
		);
		expect(miss.unclassified).toEqual(["lib/special-extra.ts"]);
	});

	test("excluídos não entram em reviewers", () => {
		const result = classifyEntries(
			parseEntries("M\tdist/x.js\nM\tsrc/alpha/y.ts"),
			fakeReviewConfig,
		);
		expect(result.excluded).toEqual(["dist/x.js"]);
		expect(result.reviewers.alpha).toEqual(["src/alpha/y.ts"]);
	});

	test("deletados não entram em reviewers mas ficam em deleted", () => {
		const result = classifyEntries(
			parseEntries("D\tsrc/alpha/old.ts"),
			fakeReviewConfig,
		);
		expect(result.deleted).toEqual(["src/alpha/old.ts"]);
		expect(result.reviewers.alpha).toBeUndefined();
		expect(result.files["src/alpha/old.ts"]).toEqual({ status: "deleted" });
	});

	test("stats refletem o número de arquivos por reviewer", () => {
		const result = classifyEntries(
			parseEntries("M\tsrc/alpha/a.ts\nM\tsrc/alpha/b.ts"),
			fakeReviewConfig,
		);
		expect(result.stats.alpha).toBe(2);
	});
});

describe("isExcludedPath", () => {
	test("casa os padrões de exclusão", () => {
		expect(isExcludedPath("dist/x.js", fakeReviewConfig.exclusions)).toBe(true);
		expect(isExcludedPath("bun.lock", fakeReviewConfig.exclusions)).toBe(true);
		expect(isExcludedPath("src/alpha/x.ts", fakeReviewConfig.exclusions)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// doc-discoverer
// ---------------------------------------------------------------------------

describe("discoverDocs", () => {
	test("sempre inclui os docs de alwaysIncludeDocs", () => {
		expect(discoverDocs(["src/alpha/x.ts"], fakeReviewConfig)).toContain("README.md");
	});

	test("aplica os docMappings do projeto", () => {
		expect(discoverDocs(["src/beta/y.ts"], fakeReviewConfig)).toContain("README.md");
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

	test("parseReviewerReport rejeita severidade inválida", () => {
		const report = parseReviewerReport(
			{
				reviewerId: "alpha",
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

	test("dedupeFindings mescla revisores e mantém a severidade mais grave", () => {
		const reports: ReviewerReport[] = [
			{
				reviewerId: "alpha",
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
				reviewerId: "beta",
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
		expect(merged[0].reviewers).toHaveLength(2);
		expect(merged[0].severity).toBe("blocking");
		expect(merged[0].message).toBe("maior");
	});

	test("renderReport marca status conforme severidade", () => {
		const reports: ReviewerReport[] = [
			{ reviewerId: "alpha", reviewedFiles: ["s.ts"], skipped: [], findings: [] },
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
					reviewers: ["alpha"],
				},
			],
			{},
		);
		expect(blockers).toContain("❌ Mudanças Necessárias");
		expect(blockers).toContain("## ❌ blocking");
	});

	test("renderReport mostra cobertura pendente", () => {
		const reports: ReviewerReport[] = [
			{ reviewerId: "alpha", reviewedFiles: ["s.ts"], skipped: [], findings: [] },
		];
		const md = renderReport("main", reports, [], {
			classified: { alpha: ["s.ts", "t.ts"] },
		});
		expect(md).toContain("faltam 1");
	});

	test("renderReport usa o resolver de nome injetado", () => {
		const reports: ReviewerReport[] = [
			{ reviewerId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
		];
		const md = renderReport("main", reports, [], {}, undefined, undefined, (id) =>
			id === "alpha" ? "Revisor Alpha" : id,
		);
		expect(md).toContain("Revisor Alpha");
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
		const reports: ReviewerReport[] = [
			{ reviewerId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
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
		const reports: ReviewerReport[] = [
			{ reviewerId: "alpha", reviewedFiles: [], skipped: [], findings: [] },
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

	test("inclui regras, arquivos e output do revisor", () => {
		const brief = renderBrief(alphaReviewer, {
			reviewerId: "alpha",
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
			reviewerId: "alpha",
			files: [],
			branch: "main",
			outputPath: "o.json",
			outputFormatPath: OUTPUT_FORMAT,
			docs: [],
			statuses: {},
			deleted: ["src/alpha/old.ts"],
		};
		const breakingDef = { ...alphaReviewer, breakingChange: true };
		expect(renderBrief(breakingDef, args)).toContain("Deletados");
		expect(renderBrief(alphaReviewer, args)).not.toContain("Deletados");
	});

	test("injeta o contexto da PR quando presente", () => {
		const brief = renderBrief(alphaReviewer, {
			reviewerId: "alpha",
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

	test("hook custom de renderBrief é usado no lugar do default", () => {
		const custom = { ...alphaReviewer, renderBrief: () => ["# Custom"] };
		const brief = renderBrief(custom, {
			reviewerId: "alpha",
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

	test("build agrega revisores sem chaves duplicadas", () => {
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

// ---------------------------------------------------------------------------
// Jev — detector (fail-open)
// ---------------------------------------------------------------------------

describe("jev-detector", () => {
	const classification: ClassificationResult = {
		reviewers: { alpha: ["src/alpha/x.ts"] },
		files: { "src/alpha/x.ts": { status: "modified" } },
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
					reviewerId: "alpha",
					rule: "R",
					severity: "blocking",
					file: "a.ts",
					confidence: 0.8,
					questionKey: "alpha::anti-0",
				},
			],
		};
		try {
			new JevCandidatesStore(file, fakeReviewConfig.reviewerIds).write(data);
			const read = new JevCandidatesStore(
				file,
				fakeReviewConfig.reviewerIds,
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
			fakeReviewConfig.reviewerIds,
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

describe("renderReviewerContext", () => {
	test("markdown inclui nome e escopo", () => {
		const md = renderReviewerContext(fakeReviewConfig, "alpha");
		expect(md).toContain("# Alpha");
		expect(md).toContain("**Escopo:**");
	});

	test("json inclui id; com --rules inclui regras", () => {
		const json = renderReviewerContext(fakeReviewConfig, "alpha", {
			json: true,
			withRules: true,
		});
		const parsed = JSON.parse(json ?? "{}");
		expect(parsed.id).toBe("alpha");
		expect(parsed.rules).toBeDefined();
	});

	test("id inexistente devolve null", () => {
		expect(renderReviewerContext(fakeReviewConfig, "nao-existe")).toBeNull();
	});
});
