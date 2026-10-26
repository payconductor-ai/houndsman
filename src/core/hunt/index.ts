/**
 * Fachada do harness local (`core/hunt`).
 *
 * A skill `/houndsman hunt` não importa nada daqui: este módulo é exclusivo do
 * caminho CLI (`houndsman hunt`), que usa o maki para executar os briefs.
 */

export type {
	HuntEvent,
	HuntReport,
	HuntRunnerOptions,
	HuntTotals,
	HuntWatchdogResult,
} from "./hunt-runner";
export { HuntRunner } from "./hunt-runner";
export type {
	InstallMakiOptions,
	InstallMakiResult,
	MakiBinary,
	MakiBinarySource,
	MakiInstallManifest,
} from "./maki-install";
export {
	installMaki,
	makiCurrentFile,
	makiInstallDir,
	makiSourceLabel,
	makiToolsRoot,
	probeMakiVersion,
	readMakiInstall,
	requireMakiBinary,
	resolveMakiBinary,
	uninstallMaki,
} from "./maki-install";
export type { HuntIntentPromptInput } from "./maki-intent-prompt";
export { renderHuntIntentPrompt, renderIntentRetrySuffix } from "./maki-intent-prompt";
export type { MakiModel } from "./maki-model";
export {
	houndsmanKeyEnvFor,
	MAKI_API_KEY_ENV,
	requireMakiModel,
	resolveMakiModel,
} from "./maki-model";
export type {
	AdversarialCandidate,
	AdversarialPromptInput,
	BookkeepingPromptInput,
} from "./maki-prompt";
export {
	ADVERSARIAL_CLASSES,
	renderAdversarialPrompt,
	renderBookkeepingPrompt,
	renderChecklistSuffix,
	renderHuntPrompt,
	renderResumeSuffix,
	renderRetrySuffix,
} from "./maki-prompt";
export type {
	MakiJsonOutput,
	MakiProcessRunner,
	MakiRunMetrics,
	MakiRunRequest,
	MakiRunResult,
	MakiUsage,
} from "./maki-runner";
export {
	extractJsonObject,
	MAKI_DISALLOWED_TOOLS,
	MAKI_REVIEW_SYSTEM_PROMPT,
	makiArgs,
	metricsFrom,
	parseMakiOutput,
	SpawnMakiRunner,
} from "./maki-runner";
export { mapPool } from "./pool";
export type {
	BusinessDecision,
	CheckCoverage,
	CheckVerdict,
	ReviewCheck,
	ReviewRule,
	RuleCheck,
} from "./review-checks";
export {
	briefRules,
	businessScore,
	chooseBusinessSummary,
	expectedReviewItems,
	mergeFindings,
	mergeRuleChecks,
	missingReviewItems,
	missingRuleChecks,
	parseReviewChecks,
	parseRuleChecks,
	summarizeChecks,
	summarizeRuleChecks,
	withInferredRule,
} from "./review-checks";
