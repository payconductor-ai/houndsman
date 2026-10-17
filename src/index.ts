/**
 * API pública do `houndsman`.
 *
 * O consumidor importa daqui para definir a configuração do projeto
 * (`houndsman.config.ts`): watchdogs, tipos e helpers de autoria.
 */

export { ArgParser } from "./core/arg-parser";
export { assetPath, OUTPUT_FORMAT_FILE } from "./core/assets";
export { defaultRenderBrief, PROCEDURE, renderBrief } from "./core/brief";
export type { FindingsCommandResult } from "./core/commands/findings";
export { runFindingsCommand, runVerifyCommand } from "./core/commands/findings";
export { ProjectScaffolder } from "./core/commands/scaffold";
export type {
	HoundsmanBudgets,
	HoundsmanConcurrency,
	HoundsmanConfig,
	HoundsmanConfigInput,
	HoundsmanStorage,
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
export { DocDiscoverer } from "./core/doc-discoverer";
export { Classification } from "./core/domain/classification";
export { Diff } from "./core/domain/diff";
export { Watchdog } from "./core/domain/watchdog";
export { buildCarryover, mergeCarryover } from "./core/engine/carryover";
export { HoundsmanEngine } from "./core/engine/houndsman-engine";
export { ReviewScopeResolver } from "./core/engine/review-scope";
export { ReviewSession } from "./core/engine/review-session";
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
	FindingIdResolution,
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
	compareFindings,
	emptyState,
	FINDING_DECISIONS,
	FINDING_EXEC_STATES,
	FINDINGS_STATE_VERSION,
	Finding,
	FindingsRepository,
	FindingsState,
	FindingsStateStore,
	fileReader,
	filterFindings,
	newFindingId,
	reorder,
	resolveFindingId,
	summarize,
	syncState,
} from "./core/findings-state";
export type { GitResult, GitRunner } from "./core/git-runner";
export {
	CORE_DIR,
	CORE_SKILL_DIR,
	displayPath,
	OUTPUT_FORMAT_PATH,
	PROJECT_DIR,
	relFromRoot,
} from "./core/paths";
export { ProjectConfig } from "./core/project-config";
export { checkRegistry } from "./core/registry-check";
export { BriefRenderer } from "./core/renderers/brief-renderer";
export { ManifestWriter } from "./core/renderers/manifest-writer";
export { ReportRenderer } from "./core/renderers/report-renderer";
export type { DomainReport } from "./core/report-builder";
export { renderDomainReport } from "./core/report-builder";
export type { Clock } from "./core/services/clock";
export { systemClock } from "./core/services/clock";
export { FileClassifier } from "./core/services/file-classifier";
export { FixBatchBuilder } from "./core/services/fix-batch-builder";
export type { GhResult, GhRunner } from "./core/services/gh-client";
export { GhClient } from "./core/services/gh-client";
export { GitRepository } from "./core/services/git-repository";
export { ProjectFiles } from "./core/services/project-files";
export { Verifier } from "./core/services/verifier";
export {
	createMemoryStorage,
	createStorage,
} from "./core/storage/factory";
export { FileStorageProvider } from "./core/storage/file/file-storage";
export {
	buildRepoIdentity,
	normalizeRemote,
	resolveRepoIdentity,
} from "./core/storage/repo-identity";
export { SQLiteStorageProvider } from "./core/storage/sqlite/sqlite-storage";
export type {
	ArtifactKind,
	ArtifactRecord,
	CreateReviewInput,
	RepoIdentity,
	ReviewPatch,
	ReviewRecord,
	ReviewStatus,
	StorageProvider,
	WriteArtifactInput,
} from "./core/storage/types";
export { ReviewWorkArea } from "./core/storage/work-area";
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
	WatchdogRegistry,
} from "./core/watchdog-registry";
export type { ServerOptions } from "./server";
export { createRequestHandler, HoundsmanServer, startServer } from "./server";
export { RunRepository } from "./server/run-repository";
