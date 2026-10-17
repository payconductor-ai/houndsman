/**
 * Barrel do harness nativo.
 *
 * Atenção: `src/skill/` é o harness **externo** (markdown). Este é o runtime de
 * agentes do próprio houndsman.
 */

export type { AgentContext } from "./agent/agent-context";
export { AgentFactory } from "./agent/agent-factory";
export type { AgentReporter } from "./agent/agent-reporter";
export { LoggerReporter, SilentReporter } from "./agent/agent-reporter";
export type { AgentResult } from "./agent/agent-result";
export { AgentRunner } from "./agent/agent-runner";
export { AgentScheduler } from "./agent/agent-scheduler";
export { ReviewAgent } from "./agent/review-agent";
export { HarnessConfig, type HarnessOverrides } from "./config/harness-config";
export { HuntHarness } from "./hunt/hunt-harness";
export { defaultHuntOptions, type HuntOptions, parseHuntArgs } from "./hunt/hunt-options";
export type { HuntResult } from "./hunt/hunt-result";
export { AgentState } from "./investigation/agent-state";
export type {
	CriticDecision,
	Evidence,
	FindingDraft,
	RuleCoverage,
} from "./investigation/evidence";
export { EvidenceVerifier } from "./investigation/evidence-verifier";
export { FindingCritic } from "./investigation/finding-critic";
export { InvestigationPlanner } from "./investigation/investigation-planner";
export { ReviewJournal } from "./investigation/review-journal";
export { type RuleAnalysis, RuleAnalyzer } from "./investigation/rule-analyzer";
export type { AgentTool, ToolContext, ToolResult } from "./tools/agent-tool";
export { type AgentStateName, ToolPolicy } from "./tools/tool-policy";
export { ToolRegistry } from "./tools/tool-registry";
export { Toolbox } from "./tools/toolbox";
export { FindingValidator } from "./validation/finding-validator";
