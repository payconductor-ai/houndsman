/**
 * Tools do harness: path guard, limites, cache, budget e redaction.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstService } from "../core/ast/service";
import { Watchdog } from "../core/domain/watchdog";
import { SilentReporter } from "../harness/agent/agent-reporter";
import { AgentState } from "../harness/investigation/agent-state";
import type { ToolContext } from "../harness/tools/agent-tool";
import { BuiltinToolsModule } from "../harness/tools/builtin";
import { PathGuard } from "../harness/tools/path-guard";
import { redactSecrets } from "../harness/tools/secret-redactor";
import { ToolCache } from "../harness/tools/tool-cache";
import { ToolCallBudget } from "../harness/tools/tool-call-budget";
import { ToolMiddleware } from "../harness/tools/tool-middleware";
import { ToolRegistry } from "../harness/tools/tool-registry";
import { EchoTool } from "./fixtures/fake-agent-tools";
import { fakeAgentContext } from "./fixtures/fake-investigation";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

const dir = mkdtempSync(join(tmpdir(), "houndsman-tools-"));
mkdirSync(join(dir, "src/alpha"), { recursive: true });
writeFileSync(
	join(dir, "src/alpha/a.ts"),
	"const x: any = 1;\nconsole.log(x);\nconst y = 2;\n",
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function context(): ToolContext {
	const state = new AgentState();
	return {
		repoRoot: dir,
		watchdog: new Watchdog(fakeHoundsmanConfig.watchdogs.alpha),
		diff: { byFile: new Map(), churn: new Map() },
		ast: new AstService(fakeHoundsmanConfig),
		state,
		budget: new ToolCallBudget(20, 10),
		cache: new ToolCache(),
		logger: new SilentReporter(),
		agent: fakeAgentContext({ repoRoot: dir }),
		rules: new Map(),
	};
}

describe("PathGuard", () => {
	test("bloqueia traversal, .git e .env", () => {
		const guard = new PathGuard(dir);
		expect(() => guard.resolvePath("../segredo")).toThrow();
		expect(() => guard.resolvePath(".git/config")).toThrow();
		expect(() => guard.resolvePath(".env")).toThrow();
	});

	test("aceita caminho interno", () => {
		const guard = new PathGuard(dir);
		expect(guard.resolvePath("src/alpha/a.ts")).toContain("a.ts");
	});
});

describe("read_file_range", () => {
	test("devolve faixa numerada + evidência com id", async () => {
		const registry = new ToolRegistry();
		registry.registerModule(new BuiltinToolsModule());
		const middleware = new ToolMiddleware();
		const ctx = context();
		const result = await registry.execute(
			"read_file_range",
			{ path: "src/alpha/a.ts", startLine: 1, endLine: 2 },
			ctx,
			middleware,
		);
		expect(result.ok).toBe(true);
		const data = result.data as { content: string };
		expect(data.content).toContain("1\tconst x: any = 1;");
		expect(data.content).toContain("2\tconsole.log(x);");
		expect(result.evidence?.[0]?.id).toBeTruthy();
		expect(ctx.state.evidence.size).toBe(1);
	});

	test("caminho fora do repo vira erro estruturado", async () => {
		const registry = new ToolRegistry();
		registry.registerModule(new BuiltinToolsModule());
		const result = await registry.execute(
			"read_file_range",
			{ path: "../x", startLine: 1, endLine: 2 },
			context(),
			new ToolMiddleware(),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("fora do repositório");
	});
});

describe("ToolRegistry / middleware", () => {
	test("nome duplicado falha no registro", () => {
		const registry = new ToolRegistry();
		registry.registerTool(new EchoTool());
		expect(() => registry.registerTool(new EchoTool())).toThrow();
	});

	test("resultado em cache não consome budget", async () => {
		const registry = new ToolRegistry();
		registry.registerTool(new EchoTool());
		const middleware = new ToolMiddleware();
		const ctx = context();
		await registry.execute("echo", { value: "a" }, ctx, middleware);
		expect(ctx.budget.total).toBe(1);
		await registry.execute("echo", { value: "a" }, ctx, middleware);
		expect(ctx.budget.total).toBe(1);
		await registry.execute("echo", { value: "b" }, ctx, middleware);
		expect(ctx.budget.total).toBe(2);
	});

	test("input inválido vira erro (Zod)", async () => {
		const registry = new ToolRegistry();
		registry.registerTool(new EchoTool());
		const result = await registry.execute(
			"echo",
			{ value: 1 },
			context(),
			new ToolMiddleware(),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("input inválido");
	});

	test("budget esgotado interrompe", async () => {
		const registry = new ToolRegistry();
		registry.registerTool(new EchoTool());
		const ctx = context();
		ctx.budget = new ToolCallBudget(1, 1);
		const middleware = new ToolMiddleware();
		await registry.execute("echo", { value: "a" }, ctx, middleware);
		const second = await registry.execute("echo", { value: "b" }, ctx, middleware);
		expect(second.ok).toBe(false);
		expect(second.error).toContain("Orçamento");
	});
});

describe("redaction", () => {
	test("remove tokens e chaves", () => {
		expect(redactSecrets("token sk-abcdefgh123")).toContain("[REDACTED]");
		expect(redactSecrets("api_key = segredo")).toContain("[REDACTED]");
	});
});
