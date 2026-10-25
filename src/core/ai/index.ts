/**
 * Barrel da camada de IA (`core/ai`).
 */

export type { AiProviderKind, AiProviderOptions } from "../config";
export type {
	AiClientOptions,
	AiCredentialCheck,
	ObjectRequest,
	TextRequest,
} from "./ai-client";
export { AiClient } from "./ai-client";
export {
	AiSdkModelProvider,
	formatSdkWarning,
	formatSdkWarnings,
	mapUsage,
} from "./ai-sdk-model-provider";
export {
	AiBudgetError,
	AiConfigurationError,
	AiProviderError,
	errorMessage,
} from "./errors";
export { AiBriefEnricher } from "./features/brief-enricher";
export { AiBusinessAnalyzer } from "./features/business-analyzer";
export { AiBusinessSummarizer } from "./features/business-summarizer";
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
	type BriefCheck,
	BriefCheckSchema,
	type BriefPlan,
	BriefPlanSchema,
	BusinessHypothesesSchema,
	type BusinessHypothesis,
	type BusinessSummaryPlan,
	BusinessSummarySchema,
	CandidateSchema,
	ClassificationSchema,
	type ContextSummaryPlan,
	ContextSummarySchema,
	SeveritySchema,
	type TechnicalSummaryPlan,
	TechnicalSummarySchema,
	VerifySchema,
} from "./schemas";
export {
	type AiResult,
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
