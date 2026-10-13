/**
 * API pública do `houndsman`.
 *
 * O consumidor importa daqui para definir a configuração do projeto
 * (`houndsman.config.ts`): watchdogs, tipos e helpers de autoria.
 */

export { assetPath, OUTPUT_FORMAT_FILE } from "./core/assets";
export { defaultRenderBrief, PROCEDURE, renderBrief } from "./core/brief";
export type { FindingsCommandResult } from "./core/commands/findings";
export { runFindingsCommand, runVerifyCommand } from "./core/commands/findings";
export type {
	HoundsmanBudgets,
	HoundsmanConcurrency,
	HoundsmanConfig,
	HoundsmanConfigInput,
} from "./core/config";
export {
	DEFAULT_ALWAYS_INCLUDE_DOCS,
	DEFAULT_JEV_CONCURRENCY,
	DEFAULT_MAX_FILES_PER_BRIEF,
	defineHoundsmanConfig,
	resolveJevConcurrency,
	resolveMaxFilesPerBrief,
} from "./core/config";
export type { LoadedConfig } from "./core/config-loader";
export {
	CONFIG_FILE_CANDIDATES,
	loadConfig,
	resolveConfigPath,
} from "./core/config-loader";
export {
	collectChurn,
	collectDiff,
	type DiffSource,
	parseDiffIndex,
	parseNumstat,
} from "./core/diff-source";
export {
	churnOf,
	classifyEntries,
	classifyRange,
	isExcludedPath,
	matchWatchdogs,
	parseEntries,
	selectByBudget,
	sortByRisk,
} from "./core/file-classifier";
export type {
	AnchorLocation,
	FindingAnchor,
	ReanchorStatus,
} from "./core/finding-anchor";
export {
	buildAnchor,
	fingerprintOf,
	hashKey,
	locateAnchor,
	normalizeLine,
	reanchor,
} from "./core/finding-anchor";
export type {
	BuildStateOptions,
	FileReader,
	FindingDecision,
	FindingExecState,
	FindingHistoryEntry,
	FindingState,
	FindingsFilter,
	FindingsStateFile,
	FindingsSummary,
	FindingUpdate,
	SyncResult,
} from "./core/findings-state";
export {
	applyFindingUpdate,
	buildStateFromFindings,
	buildStateFromRunDir,
	compareFindings,
	emptyState,
	FINDING_DECISIONS,
	FINDING_EXEC_STATES,
	FINDINGS_STATE_VERSION,
	FindingsStateStore,
	fileReader,
	filterFindings,
	newFindingId,
	reorder,
	runDir,
	stateFile,
	summarize,
	syncState,
} from "./core/findings-state";
export {
	ARTIFACT_DIR,
	CORE_DIR,
	CORE_SKILL_DIR,
	OUTPUT_FORMAT_PATH,
	PROJECT_DIR,
	relFromRoot,
	STATE_FILE,
} from "./core/paths";
export { checkRegistry } from "./core/registry-check";
export type { DomainReport } from "./core/report-builder";
export { renderDomainReport } from "./core/report-builder";
export type {
	ChurnMap,
	ClassifyRule,
	FileChurn,
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
export type { ServerOptions } from "./server";
export { createRequestHandler, startServer } from "./server";
