/**
 * Baseline de comportamento (Fase 0 do refactor OO).
 *
 * Congela a saída observável do motor — briefs, relatórios, camada gerada e
 * artefatos de `prepare`/`finalize` — para provar que o refactor não muda
 * comportamento. Qualquer divergência nesses snapshots é uma regressão.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { renderBrief } from "../core/brief";
import {
	createScaffoldContext,
	syncGeneratedFiles,
	writeUserLayer,
} from "../core/commands/scaffold";
import { defineHoundsmanConfig } from "../core/config";
import { defaultOptions, finalize, prepare, reviewContext } from "../core/orchestrator";
import { displayPath } from "../core/paths";
import {
	type MergedFinding,
	renderDomainReport,
	renderReport,
	type WatchdogReport,
} from "../core/report-builder";
import { resolveRepoIdentity } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import { defineWatchdog } from "../core/types";
import * as facade from "../index";

// ---------------------------------------------------------------------------
// Config baseline (projeto fake, 1 watchdog para artefatos determinísticos)
// ---------------------------------------------------------------------------

const baselineWatchdog = defineWatchdog({
	id: "alpha",
	name: "Alpha",
	description: "Watchdog baseline.",
	scope: "src/alpha/**",
	classify: [{ value: "^src/alpha/" }],
	rules: [
		{ severity: "blocking", text: "Nunca usar `any`." },
		{ severity: "attention", text: "Promover: validar a entrada." },
	],
	contextFiles: ["README.md"],
	breakingChange: true,
});

const baselineConfig = defineHoundsmanConfig({
	projectName: "Baseline",
	watchdogs: { alpha: baselineWatchdog },
	exclusions: [/^dist\//],
	docMappings: [[/^src\//, ["README.md"]]],
	alwaysIncludeDocs: ["README.md"],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Substitui valores voláteis (ids, timestamps, SHAs) por marcadores estáveis. */
function normalizeArtifacts(text: string): string {
	return text
		.replace(
			/"(createdAt|updatedAt|generatedAt|startedAt|at)": "[^"]*"/g,
			'"$1": "<timestamp>"',
		)
		.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, '"<timestamp>"')
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
			"<uuid>",
		)
		.replace(/\b[0-9a-f]{40}\b/g, "<sha>")
		.replace(/\b[0-9a-f]{16}\b/g, "<fingerprint>")
		.replace(/\b[0-9a-f]{10}\b/g, "<id>")
		.replace(/\d{4}-\d{2}-\d{2}/g, "<date>");
}

/** Lista recursiva de arquivos (caminhos relativos, ordenados). */
function listFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else files.push(relative(root, full).replace(/\\/g, "/"));
		}
	};
	walk(root);
	return files.sort();
}

/** Executa git no diretório e devolve stdout (lança em falha). */
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

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

describe("baseline — brief", () => {
	test("defaultRenderBrief (contexto, churn, overflow, candidatos e deletados)", () => {
		const brief = renderBrief(baselineWatchdog, {
			watchdogId: "alpha",
			files: ["src/alpha/a.ts", "src/alpha/b.ts"],
			statuses: {
				"src/alpha/a.ts": { status: "modified" },
				"src/alpha/b.ts": { status: "added" },
			},
			churn: {
				"src/alpha/a.ts": { additions: 3, deletions: 1 },
				"src/alpha/b.ts": { additions: 2, deletions: 0 },
			},
			overflow: ["src/alpha/c.ts"],
			deleted: ["src/alpha/old.ts"],
			branch: "feature/x",
			outputPath: "/workspace/work/review-x/findings/alpha.json",
			outputFormatPath: ".houndsman/core/skill/OUTPUT-FORMAT.md",
			docs: ["AGENTS.md", "README.md"],
			context: {
				objective: "Entregar X",
				motivation: "Reduzir Y",
				changeSummary: ["Faz A", "Remove B"],
			},
			candidates: [
				{
					file: "src/alpha/a.ts",
					severity: "blocking",
					confidence: 0.82,
					rule: "Nunca usar `any`.",
				},
			],
		});

		expect(brief).toMatchSnapshot();
	});
});

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

const reports: WatchdogReport[] = [
	{
		watchdogId: "alpha",
		reviewedFiles: ["src/alpha/a.ts", "src/alpha/b.ts"],
		skipped: ["src/alpha/c.ts"],
		findings: [
			{
				rule: "Nunca usar `any`.",
				severity: "blocking",
				file: "src/alpha/a.ts",
				line: 1,
				message: "any detectado",
				action: "tipar",
				evidence: "export const a: any = 1;",
				id: "id-alpha",
			},
			{
				rule: "Promover: validar a entrada.",
				severity: "attention",
				file: "src/alpha/b.ts",
				line: 2,
				message: "sem validação",
				action: "adicionar schema",
				id: "id-beta",
			},
		],
	},
	{
		watchdogId: "beta",
		reviewedFiles: ["src/beta/x.test.ts"],
		skipped: [],
		findings: [],
	},
];

const merged: MergedFinding[] = [
	{ ...reports[0].findings[0], watchdogs: ["alpha"] },
	{ ...reports[0].findings[1], watchdogs: ["alpha", "beta"] },
];

const reportContext = {
	available: true,
	source: {
		number: 42,
		title: "Entrega X",
		url: "https://example.test/pull/42",
		head: "feature/x",
		base: "main",
	},
	objective: "Entregar X",
	motivation: "Reduzir Y",
	changeSummary: ["Faz A", "Remove B"],
};

describe("baseline — relatório", () => {
	test("renderReport consolidado", () => {
		const md = renderReport(
			"feature/x",
			reports,
			merged,
			{ classified: { alpha: ["src/alpha/a.ts", "src/alpha/b.ts"], beta: [] } },
			reportContext,
			[
				{
					watchdogId: "alpha",
					rule: "Nunca usar `any`.",
					severity: "blocking",
					file: "src/alpha/a.ts",
					confidence: 0.82,
					questionKey: "alpha::rule-0",
				},
			],
			(id) => (id === "alpha" ? "Alpha" : "Beta"),
			[
				{
					id: "alpha",
					name: "Alpha",
					file: "review.alpha.md",
					findings: 2,
					reviewedFiles: 2,
					expectedFiles: 2,
				},
			],
		);

		expect(normalizeArtifacts(md)).toMatchSnapshot();
	});

	test("renderDomainReport isolado", () => {
		const md = renderDomainReport(
			"feature/x",
			reports[0],
			merged,
			2,
			reportContext,
			(id) => (id === "alpha" ? "Alpha" : "Beta"),
		);

		expect(normalizeArtifacts(md)).toMatchSnapshot();
	});
});

// ---------------------------------------------------------------------------
// Camada gerada pelo setup/update
// ---------------------------------------------------------------------------

/** Arquivos-template cujo conteúdo precisa permanecer idêntico. */
const TEMPLATE_FILES = [
	"houndsman.config.ts",
	".houndsman/core/types.ts",
	".houndsman/watchdogs/example.ts",
	".houndsman/watchdogs/index.ts",
	".houndsman/exclusions.ts",
	".houndsman/doc-mappings.ts",
	".houndsman/.gitignore",
	".agents/skills/houndsman/SKILL.md",
	".claude/skills/houndsman/SKILL.md",
];

describe("baseline — camada gerada", () => {
	test("setup gera os mesmos arquivos e conteúdos", () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-baseline-scaffold-"));
		try {
			const ctx = createScaffoldContext(cwd, ["--name", "acme"], false);
			writeUserLayer(ctx);
			syncGeneratedFiles(ctx);

			const files = listFiles(cwd);
			expect(files).toMatchSnapshot();

			const contents = Object.fromEntries(
				TEMPLATE_FILES.map((file) => [
					file,
					readFileSync(join(cwd, file), "utf8"),
				]),
			);
			expect(contents).toMatchSnapshot();

			// Assets copiados (skill docs): hash estável, sem colar o markdown inteiro.
			const skillDocs = files
				.filter((file) => file.startsWith(".houndsman/core/skill/"))
				.map((file) => ({
					file,
					sha256: createHash("sha256")
						.update(readFileSync(join(cwd, file), "utf8"))
						.digest("hex")
						.slice(0, 16),
				}));
			expect(skillDocs).toMatchSnapshot();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// prepare → findings → finalize (end-to-end em repo git temporário)
// ---------------------------------------------------------------------------

describe("baseline — artefatos de prepare/finalize", () => {
	test("gera classification, brief, manifest, review e state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-baseline-run-"));
		const originalCwd = process.cwd();
		const originalHome = process.env.HOUNDSMAN_HOME;
		let storage: SQLiteStorageProvider | null = null;

		try {
			git(cwd, ["init", "-b", "main"]);
			git(cwd, ["config", "user.email", "baseline@example.test"]);
			git(cwd, ["config", "user.name", "Baseline"]);
			// Evita assinatura de commit (ex.: 1Password) no repo temporário.
			git(cwd, ["config", "commit.gpgsign", "false"]);
			git(cwd, ["config", "tag.gpgsign", "false"]);
			mkdirSync(join(cwd, "src", "alpha"), { recursive: true });
			writeFileSync(join(cwd, "src", "alpha", "a.ts"), "export const a = 1;\n");
			writeFileSync(join(cwd, "src", "alpha", "old.ts"), "export const old = 1;\n");
			writeFileSync(join(cwd, "README.md"), "# Baseline\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "initial"]);
			const base = git(cwd, ["rev-parse", "HEAD"]).trim();

			writeFileSync(
				join(cwd, "src", "alpha", "a.ts"),
				"export const a: any = 1;\nexport const b = 2;\n",
			);
			writeFileSync(join(cwd, "src", "alpha", "b.ts"), "export const b = 3;\n");
			rmSync(join(cwd, "src", "alpha", "old.ts"));
			git(cwd, ["add", "-A"]);
			git(cwd, ["commit", "-m", "change"]);

			const opts = {
				...defaultOptions(),
				base,
				head: "HEAD",
				noJev: true,
			};

			process.env.HOUNDSMAN_HOME = join(cwd, ".home");
			process.chdir(cwd);

			const config = {
				...baselineConfig,
				storage: {
					provider: "sqlite" as const,
					path: join(cwd, "houndsman.db"),
				},
			};
			storage = new SQLiteStorageProvider(join(cwd, "houndsman.db"));
			const repo = resolveRepoIdentity();
			const review = storage.getOrCreateReview({
				repo,
				branch: "main",
				slug: "main",
			});
			const ctx = reviewContext(storage, review);
			const homeDisplay = displayPath(cwd);
			const escapedCwd = cwd.replace(/\\/g, "\\\\");
			const normalize = (text: string): string =>
				normalizeArtifacts(
					text
						.replaceAll(escapedCwd, "<cwd>")
						.replaceAll(cwd, "<cwd>")
						.replaceAll(cwd.replace(/\\/g, "/"), "<cwd>")
						.replaceAll(cwd.replace(/\\/g, "/").toLowerCase(), "<cwd>")
						.replaceAll(homeDisplay, "<cwd>"),
				);

			const prepared = await prepare(opts, "main", config, ctx);
			expect(normalize(prepared.messages.join("\n"))).toMatchSnapshot();

			for (const name of ["classification.json", "manifest.json"]) {
				const artifact = storage.readArtifact(review.id, name);
				expect(normalize(artifact?.content ?? "")).toMatchSnapshot(name);
			}
			expect(
				normalize(readFileSync(ctx.work.briefFile("alpha"), "utf8")),
			).toMatchSnapshot("briefs/alpha.md");

			writeFileSync(
				ctx.work.findingFile("alpha"),
				`${JSON.stringify(
					{
						watchdogId: "alpha",
						reviewedFiles: ["src/alpha/a.ts", "src/alpha/b.ts"],
						skipped: [],
						findings: [
							{
								rule: "Nunca usar `any`.",
								severity: "blocking",
								file: "src/alpha/a.ts",
								line: 1,
								message: "any detectado",
								action: "tipar",
								evidence: "export const a: any = 1;",
							},
						],
					},
					null,
					2,
				)}\n`,
			);

			const finalized = finalize(opts, "main", config, ctx);
			expect(normalize(finalized.messages.join("\n"))).toMatchSnapshot();

			for (const name of ["review.md", "review.alpha.md"]) {
				const artifact = storage.readArtifact(review.id, name);
				expect(normalize(artifact?.content ?? "")).toMatchSnapshot(name);
			}
			expect(
				normalize(JSON.stringify(storage.readFindings(review.id), null, 2)),
			).toMatchSnapshot("state.json");
			expect(
				normalize(JSON.stringify(storage.getReview(review.id), null, 2)),
			).toMatchSnapshot("run.json");
		} finally {
			storage?.close();
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOUNDSMAN_HOME;
			else process.env.HOUNDSMAN_HOME = originalHome;
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Contrato da API pública (facade src/index.ts)
// ---------------------------------------------------------------------------

/** Símbolos que consumidores importam de `@payconductor/houndsman`. */
const REQUIRED_EXPORTS = [
	"PROCEDURE",
	"SEVERITY_EMOJI",
	"SEVERITY_ORDER",
	"FINDING_DECISIONS",
	"FINDING_EXEC_STATES",
	"FINDINGS_STATE_VERSION",
	"FindingsStateStore",
	"FindingsRepository",
	"FindingsState",
	"Finding",
	"Classification",
	"Diff",
	"DocDiscoverer",
	"FileClassifier",
	"GhClient",
	"GitRepository",
	"ProjectConfig",
	"ProjectFiles",
	"Watchdog",
	"WatchdogRegistry",
	"systemClock",
	"HoundsmanServer",
	"HoundsmanEngine",
	"ReviewWorkArea",
	"SQLiteStorageProvider",
	"FileStorageProvider",
	"createStorage",
	"createMemoryStorage",
	"resolveRepoIdentity",
	"buildRepoIdentity",
	"normalizeRemote",
	"ReviewSession",
	"ReviewScopeResolver",
	"buildCarryover",
	"mergeCarryover",
	"RunRepository",
	"ArgParser",
	"ProjectScaffolder",
	"FixBatchBuilder",
	"BriefRenderer",
	"ReportRenderer",
	"ManifestWriter",
	"applyFindingUpdate",
	"assetPath",
	"buildAnchor",
	"buildStateFromFindings",
	"checkRegistry",
	"churnOf",
	"classifyEntries",
	"classifyRange",
	"collectChurn",
	"collectDiff",
	"compareFindings",
	"createRequestHandler",
	"defaultRenderBrief",
	"defineHoundsmanConfig",
	"defineWatchdog",
	"emptyState",
	"fileReader",
	"filterFindings",
	"findWatchdog",
	"fingerprintOf",
	"getWatchdog",
	"getWatchdogContext",
	"hashKey",
	"isExcludedPath",
	"loadConfig",
	"locateAnchor",
	"matchWatchdogs",
	"newFindingId",
	"normalizeLine",
	"parseDiffIndex",
	"parseEntries",
	"parseNumstat",
	"reanchor",
	"relFromRoot",
	"renderBrief",
	"renderDomainReport",
	"reorder",
	"resolveConfigPath",
	"resolveJevConcurrency",
	"resolveMaxFilesPerBrief",
	"runFindingsCommand",
	"runVerifyCommand",
	"selectByBudget",
	"severityRank",
	"sortByRisk",
	"startServer",
	"summarize",
	"syncState",
] as const;

describe("baseline — API pública", () => {
	test("a facade mantém todos os símbolos exportados", () => {
		for (const name of REQUIRED_EXPORTS) {
			expect(facade).toHaveProperty(name);
		}
	});
});
