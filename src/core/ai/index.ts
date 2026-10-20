/**
 * Barrel da camada de IA (`core/ai`).
 */

export type { AiProviderKind } from "../config";
export type {
	AiClientOptions,
	AiCredentialCheck,
	ObjectRequest,
	TextRequest,
} from "./ai-client";
export { AiClient } from "./ai-client";
export { AiSdkModelProvider, mapUsage } from "./ai-sdk-model-provider";
export {
	AiBudgetError,
	AiConfigurationError,
	AiProviderError,
	errorMessage,
} from "./errors";
export { AiBriefEnricher } from "./features/brief-enricher";
export { AiClassifier } from "./features/classifier";
export { AiContextSummarizer } from "./features/context-summarizer";
export { AiPreAnalyzer } from "./features/pre-analyzer";
export { AiTechnicalSummarizer } from "./features/technical-summarizer";
export { AiVerifier } from "./features/verifier";
export { hasProviderCredential, ModelFactory } from "./model-factory";
export {
	type AiCandidate,
	type AiClassification,
	type AiVerdict,
	type AiWatchdogReport,
	type BriefPlan,
	BriefPlanSchema,
	CandidateSchema,
	ClassificationSchema,
	type ContextSummaryPlan,
	ContextSummarySchema,
	SeveritySchema,
	type TechnicalSummaryPlan,
	TechnicalSummarySchema,
	VerifySchema,
	WatchdogReportSchema,
} from "./schemas";
export {
	type AiResult,
	type AiTool,
	type AiUsage,
	addUsage,
	emptyUsage,
	type ModelProvider,
	type ModelRequest,
	type ModelResponse,
} from "./types";
export { type AiBudgetLimits, AiUsageBudget } from "./usage-budget";
export {
	type AiUsageEntry,
	type AiUsageFile,
	AiUsageRecorder,
} from "./usage-recorder";
