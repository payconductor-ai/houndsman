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
export { renderHuntPrompt, renderRetrySuffix } from "./maki-prompt";
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
	makiArgs,
	metricsFrom,
	parseMakiOutput,
	SpawnMakiRunner,
} from "./maki-runner";
export { mapPool } from "./pool";
