/**
 * Fixtures de investigação/agente (sem rede, sem git).
 */

import { AstService } from "../../core/ast/service";
import { Watchdog } from "../../core/domain/watchdog";
import type { AgentContext } from "../../harness/agent/agent-context";
import { SilentReporter } from "../../harness/agent/agent-reporter";
import type { ReviewAgentDeps } from "../../harness/agent/review-agent";
import { RuleAnalyzer } from "../../harness/investigation/rule-analyzer";
import { BuiltinToolsModule } from "../../harness/tools/builtin";
import { ToolRegistry } from "../../harness/tools/tool-registry";
import type { FakeModelProvider } from "./fake-model-provider";
import { fakeHoundsmanConfig } from "./fake-project";

/** Contexto de agente para o watchdog `alpha`. */
export function fakeAgentContext(overrides: Partial<AgentContext> = {}): AgentContext {
	const watchdog = new Watchdog(fakeHoundsmanConfig.watchdogs.alpha);
	const rules = new RuleAnalyzer().analyze(watchdog.rules);
	return {
		watchdog,
		projectName: "Fake",
		branch: "main",
		files: ["src/alpha/a.ts"],
		overflow: [],
		deleted: [],
		docs: [],
		context: null,
		ast: new Map(),
		outputPath: "findings/alpha.json",
		maxSteps: 4,
		maxCalls: 8,
		repoRoot: process.cwd(),
		diff: { byFile: new Map(), churn: new Map() },
		rules,
		...overrides,
	};
}

/** Registry com tools built-in. */
export function builtinRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registry.registerModule(new BuiltinToolsModule());
	return registry;
}

/** Deps completas de um `ReviewAgent` com provider fake. */
export function fakeAgentDeps(
	provider: FakeModelProvider,
	overrides: Partial<ReviewAgentDeps> = {},
): ReviewAgentDeps {
	const context = overrides.context ?? fakeAgentContext();
	return {
		context,
		provider,
		registry: builtinRegistry(),
		reporter: new SilentReporter(),
		maxOutputTokens: 512,
		temperature: 0,
		timeoutMs: 5_000,
		ast: new AstService(fakeHoundsmanConfig),
		...overrides,
	};
}
