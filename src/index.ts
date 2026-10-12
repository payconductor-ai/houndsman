/**
 * API pública do `houndsman`.
 *
 * O consumidor importa daqui para definir a configuração do projeto
 * (`houndsman.config.ts`): watchdogs, tipos e helpers de autoria.
 */

export { assetPath, OUTPUT_FORMAT_FILE } from "./core/assets";
export { defaultRenderBrief, PROCEDURE, renderBrief } from "./core/brief";
export type { HoundsmanConfig, HoundsmanConfigInput } from "./core/config";
export { DEFAULT_ALWAYS_INCLUDE_DOCS, defineHoundsmanConfig } from "./core/config";
export type { LoadedConfig } from "./core/config-loader";
export {
	CONFIG_FILE_CANDIDATES,
	loadConfig,
	resolveConfigPath,
} from "./core/config-loader";
export {
	classifyEntries,
	classifyRange,
	isExcludedPath,
	matchWatchdogs,
	parseEntries,
} from "./core/file-classifier";
export {
	ARTIFACT_DIR,
	CORE_DIR,
	CORE_SKILL_DIR,
	OUTPUT_FORMAT_PATH,
	PROJECT_DIR,
	relFromRoot,
} from "./core/paths";
export { checkRegistry } from "./core/registry-check";
export type {
	ClassifyRule,
	FileStatus,
	FileStatusMap,
	Rule,
	Severity,
	WatchdogDefinition,
	WatchdogMeta,
	WatchdogRenderArgs,
	WatchdogRenderCandidate,
	WatchdogRenderContext,
} from "./core/types";
export {
	defineWatchdog,
	SEVERITY_EMOJI,
	SEVERITY_ORDER,
	severityRank,
} from "./core/types";
export {
	findWatchdog,
	getWatchdog,
	getWatchdogContext,
} from "./core/watchdog-registry";
