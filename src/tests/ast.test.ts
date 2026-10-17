/**
 * Testes do subsistema AST (project-agnóstico).
 *
 * Cobrem extração de fatos, delta por hunk, impacto (resolução de imports),
 * classificação estrutural e o bloco injetado no brief. Nenhuma chamada de rede.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDelta, parseHunks } from "../core/ast/diff";
import { resolveImport } from "../core/ast/impact";
import { AstParser } from "../core/ast/parser";
import { AstService } from "../core/ast/service";
import type { AstFacts } from "../core/ast/types";
import { renderBrief } from "../core/brief";
import { defineHoundsmanConfig } from "../core/config";
import { collectDiff } from "../core/diff-source";
import { matchWatchdogs, parseEntries } from "../core/file-classifier";
import { runGit } from "../core/git-runner";
import { GitRepository } from "../core/services/git-repository";
import { defineWatchdog } from "../core/types";

const parser = new AstParser();

const TS_SOURCE = `import { db } from "./db";
import type { Order } from "./types";

export class OrderService {
	constructor(private readonly database: Db) {}

	async create(input: Input): Promise<Order> {
		return db.insert(input);
	}
}

export function helper(value: string): number {
	return value.length;
}

export const handler = async (request: Request) => {
	return helper(request.url);
};

@Controller("/orders")
export class OrdersController {
	@Get(":id")
	get(): string {
		return "ok";
	}
}
`;

async function factsOf(source: string): Promise<AstFacts> {
	const facts = await parser.parseSource("typescript", source);
	if (!facts) throw new Error("parse falhou");
	return facts;
}

describe("AstParser / extractFacts", () => {
	test("extrai símbolos, exports, imports e decorators", async () => {
		const facts = await factsOf(TS_SOURCE);
		const names = facts.symbols.map((symbol) => symbol.name);

		expect(names).toContain("OrderService");
		expect(names).toContain("OrderService.create");
		expect(names).toContain("helper");
		expect(names).toContain("handler");
		expect(facts.imports.map((item) => item.source)).toEqual(["./db", "./types"]);
		expect(facts.imports[1]?.typeOnly).toBe(true);
		expect(facts.exports.map((item) => item.name)).toEqual(
			expect.arrayContaining([
				"OrderService",
				"helper",
				"handler",
				"OrdersController",
			]),
		);
		expect(facts.decorators).toEqual(["Controller", "Get"]);
		expect(facts.hasSyntaxErrors).toBe(false);
	});

	test("não quebra com sintaxe inválida (fatos parciais)", async () => {
		const facts = await factsOf("export function broken( {");
		expect(facts).not.toBeNull();
		expect(facts.hasSyntaxErrors).toBe(true);
	});

	test("não extrai variáveis aninhadas como símbolos de topo", async () => {
		const facts = await factsOf(
			"export const handler = () => { const inner = 1; return inner; };\n",
		);
		const names = facts.symbols.map((symbol) => symbol.name);
		expect(names).toContain("handler");
		expect(names).not.toContain("inner");
	});

	test("linguagem não suportada devolve null", async () => {
		expect(await parser.parseFile("README.md", "# titulo")).toBeNull();
	});
});

describe("computeDelta / parseHunks", () => {
	test("parseHunks extrai linhas novas", () => {
		const patch = [
			"@@ -1,3 +1,4 @@",
			" export function a() {",
			"-  return 1;",
			"+  const x = 1;",
			"+  return x;",
			" }",
		].join("\n");
		expect(parseHunks(patch)[0]?.addedLines).toEqual([2, 3]);
	});

	test("detecta símbolos adicionados/removidos e assinatura alterada", async () => {
		const before = await factsOf(
			"export function a(value: string): void {}\nexport const b = 1;\n",
		);
		const after = await factsOf(
			"export function a(value: number, extra: boolean): void {}\nexport function c() {}\n",
		);
		const patch = [
			"@@ -1,2 +1,2 @@",
			"-export function a(value: string): void {}",
			"+export function a(value: number, extra: boolean): void {}",
			"-export const b = 1;",
			"+export function c() {}",
		].join("\n");

		const delta = computeDelta(before, after, patch);
		expect(delta.addedSymbols.map((symbol) => symbol.name)).toContain("c");
		expect(delta.removedSymbols.map((symbol) => symbol.name)).toContain("b");
		expect(delta.changedSignatures.map((item) => item.name)).toContain("a");
		expect(delta.modifiedSymbols.map((symbol) => symbol.name)).toContain("a");
	});

	test("marca como export a mudança via `export { ... }`", async () => {
		const before = await factsOf(
			"function a(value: string): void {}\nexport { a };\n",
		);
		const after = await factsOf(
			"function a(value: number): void {}\nexport { a };\n",
		);
		const delta = computeDelta(
			before,
			after,
			"@@ -1,2 +1,2 @@\n-function a(value: string): void {}\n+function a(value: number): void {}\n export { a };",
		);
		expect(delta.changedSignatures[0]?.exported).toBe(true);
	});
});

describe("resolveImport", () => {
	const aliases = { "@/*": "src/*" };
	const existing = new Set([
		"src/db.ts",
		"src/orders/index.ts",
		"src/utils/helpers.tsx",
	]);

	test("resolve relativo com extensão implícita", () => {
		expect(
			resolveImport("src/a.ts", "./db", aliases, (path) => existing.has(path)),
		).toBe("src/db.ts");
	});

	test("resolve alias e index", () => {
		expect(
			resolveImport("src/a.ts", "@/orders", aliases, (path) => existing.has(path)),
		).toBe("src/orders/index.ts");
	});

	test("ignora pacote externo", () => {
		expect(
			resolveImport("src/a.ts", "react", aliases, (path) => existing.has(path)),
		).toBeNull();
	});
});

describe("classificação estrutural", () => {
	test("casa regras por símbolo, import, export e decorator", async () => {
		const facts = await factsOf(TS_SOURCE);
		const watchdog = defineWatchdog({
			id: "auth",
			name: "Auth",
			description: "Regras de autenticação.",
			scope: "src/**",
			classify: [
				{ type: "decorator", value: "^Controller$" },
				{ type: "import", value: "^\\./db$" },
				{ type: "symbol", value: "OrderService" },
				{ type: "export", value: "^OrdersController$" },
			],
			rules: [{ severity: "attention", text: "Promover: validar entrada." }],
			contextFiles: ["AGENTS.md"],
		});

		expect(
			matchWatchdogs(
				"src/orders.ts",
				{ auth: watchdog },
				["auth"],
				undefined,
				facts,
			),
		).toEqual(["auth"]);
	});

	test("sem fatos AST, regras estruturais não casam", () => {
		const watchdog = defineWatchdog({
			id: "auth",
			name: "Auth",
			description: "Regras de autenticação.",
			scope: "src/**",
			classify: [{ type: "decorator", value: "^Controller$" }],
			rules: [{ severity: "attention", text: "Promover: validar entrada." }],
			contextFiles: ["AGENTS.md"],
		});
		expect(matchWatchdogs("src/orders.ts", { auth: watchdog }, ["auth"])).toEqual([]);
	});
});

describe("brief", () => {
	test("injeta a seção de estrutura com delta e impacto", async () => {
		const before = await factsOf("export function a(value: string): void {}\n");
		const after = await factsOf(
			"export function a(value: number): void {}\nexport const b = 1;\n",
		);
		const delta = computeDelta(
			before,
			after,
			"@@ -1 +1,2 @@\n-export function a(value: string): void {}\n+export function a(value: number): void {}\n+export const b = 1;",
		);
		const watchdog = defineWatchdog({
			id: "alpha",
			name: "Alpha",
			description: "Watchdog de teste.",
			scope: "src/**",
			classify: [{ value: "^src/" }],
			rules: [{ severity: "attention", text: "Promover: algo." }],
			contextFiles: ["AGENTS.md"],
		});

		const brief = renderBrief(watchdog, {
			watchdogId: "alpha",
			files: ["src/a.ts"],
			statuses: { "src/a.ts": { status: "modified" } },
			deleted: [],
			branch: "main",
			outputPath: "/tmp/a.json",
			outputFormatPath: "/tmp/OUTPUT-FORMAT.md",
			docs: [],
			ast: [{ file: "src/a.ts", delta, importers: ["src/b.ts"] }],
		});

		expect(brief).toContain("## Estrutura (AST)");
		expect(brief).toContain("assinatura `a`");
		expect(brief).toContain("impacto: `src/b.ts`");
	});
});

describe("AstService (integração)", () => {
	test("analisa delta e descobre importadores via git grep", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "houndsman-ast-"));
		const originalCwd = process.cwd();
		const git = (args: string[]): string => runGit(args);

		try {
			process.chdir(cwd);
			git(["init"]);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "Test"]);
			git(["config", "commit.gpgsign", "false"]);
			mkdirSync("src", { recursive: true });
			writeFileSync(
				"src/db.ts",
				"export function connect(url: string): string { return url; }\n",
			);
			writeFileSync(
				"src/orders.ts",
				'import { connect } from "./db";\nexport function load(): string { return connect("x"); }\n',
			);
			git(["add", "."]);
			git(["commit", "-m", "base"]);

			writeFileSync(
				"src/db.ts",
				"export function connect(url: string, timeout: number): string { return url; }\n",
			);
			git(["add", "."]);
			git(["commit", "-m", "change"]);

			const config = defineHoundsmanConfig({
				projectName: "AST",
				watchdogs: {
					alpha: defineWatchdog({
						id: "alpha",
						name: "Alpha",
						description: "Teste.",
						scope: "src/**",
						classify: [{ value: "^src/" }],
						rules: [{ severity: "attention", text: "Promover: algo." }],
						contextFiles: ["AGENTS.md"],
					}),
				},
				exclusions: [],
				docMappings: [],
				ast: { aliases: {} },
			});

			const diff = collectDiff("HEAD~1", "HEAD");
			const entries = parseEntries(git(["diff", "HEAD~1...HEAD", "--name-status"]));
			const service = new AstService(config, new GitRepository());
			const analyses = await service.analyze(entries, diff, "HEAD~1");

			const changed = analyses.get("src/db.ts");
			expect(changed?.delta?.changedSignatures[0]?.name).toBe("connect");
			expect(changed?.delta?.changedSignatures[0]?.exported).toBe(true);

			const impact = await service.impact(analyses);
			expect(impact.importers["src/db.ts"]).toEqual(["src/orders.ts"]);
			expect(impact.affectedFiles).toEqual(["src/orders.ts"]);
			expect(impact.exportedChanges).toContainEqual({
				file: "src/db.ts",
				symbol: "connect",
				change: "signature",
			});
		} finally {
			process.chdir(originalCwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});
