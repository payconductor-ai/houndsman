/**
 * Contract test das tools built-in: metadata, schema e erros estruturados.
 */

import { describe, expect, test } from "bun:test";
import { AstService } from "../core/ast/service";
import { Watchdog } from "../core/domain/watchdog";
import { SilentReporter } from "../harness/agent/agent-reporter";
import { AgentState } from "../harness/investigation/agent-state";
import type { ToolContext } from "../harness/tools/agent-tool";
import { BuiltinToolsModule } from "../harness/tools/builtin";
import { ToolCache } from "../harness/tools/tool-cache";
import { ToolCallBudget } from "../harness/tools/tool-call-budget";
import { ToolMiddleware } from "../harness/tools/tool-middleware";
import { ToolRegistry } from "../harness/tools/tool-registry";
import { fakeAgentContext } from "./fixtures/fake-investigation";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

function registry(): ToolRegistry {
	const value = new ToolRegistry();
	value.registerModule(new BuiltinToolsModule());
	return value;
}

function context(): ToolContext {
	return {
		repoRoot: process.cwd(),
		watchdog: new Watchdog(fakeHoundsmanConfig.watchdogs.alpha),
		diff: { byFile: new Map(), churn: new Map() },
		ast: new AstService(fakeHoundsmanConfig),
		state: new AgentState(),
		budget: new ToolCallBudget(20, 10),
		cache: new ToolCache(),
		logger: new SilentReporter(),
		agent: fakeAgentContext({ repoRoot: process.cwd() }),
		rules: new Map(),
	};
}

describe("contratos das tools", () => {
	test("todas declaram metadata read-only e capabilities", () => {
		for (const tool of registry().list()) {
			expect(tool.metadata.name.length).toBeGreaterThan(0);
			expect(tool.metadata.description.length).toBeGreaterThan(0);
			expect(tool.metadata.readOnly).toBe(true);
			expect(tool.metadata.capabilities.length).toBeGreaterThan(0);
			expect(tool.metadata.cost).toBeGreaterThanOrEqual(1);
		}
	});

	test("nenhuma tool devolve arquivo inteiro por padrão", () => {
		// `read_file_range` exige faixa explícita.
		const range = registry().get("read_file_range");
		expect(range?.inputSchema.safeParse({ path: "a.ts" }).success).toBe(false);
		// `file_outline` só devolve metadados (não tem parâmetro de corpo).
		const outline = registry().get("file_outline");
		expect(outline?.inputSchema.safeParse({ path: "a.ts" }).success).toBe(true);
	});

	test("tools de arquivo devolvem erro estruturado (não lançam)", async () => {
		const middleware = new ToolMiddleware();
		for (const [name, input] of [
			["read_file_range", { path: "../x", startLine: 1, endLine: 2 }],
			["file_outline", { path: "../x" }],
			["imports_exports", { file: "../x" }],
		] as const) {
			const result = await registry().execute(name, input, context(), middleware);
			expect(result.ok).toBe(false);
			expect(typeof result.error).toBe("string");
		}
	});

	test("rule_signals devolve erro quando a regra não existe", async () => {
		const result = await registry().execute(
			"rule_signals",
			{ rule: "regra inexistente" },
			context(),
			new ToolMiddleware(),
		);
		expect(result.ok).toBe(false);
	});
});
