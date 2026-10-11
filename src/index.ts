/**
 * API pública do `houndsman`.
 *
 * O consumidor importa daqui para definir a configuração do projeto
 * (`houndsman.config.ts`): revisores, tipos e helpers de autoria.
 */

export { assetPath, OUTPUT_FORMAT_FILE } from "./core/assets";
export { defaultRenderBrief, PROCEDURE, renderBrief } from "./core/brief";
export type { ReviewConfig, ReviewConfigInput } from "./core/config";
export { DEFAULT_ALWAYS_INCLUDE_DOCS, defineReviewConfig } from "./core/config";
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
	matchReviewers,
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
export {
	findReviewer,
	getReviewer,
	getReviewerContext,
} from "./core/reviewer-registry";
export type {
	ClassifyRule,
	FileStatus,
	FileStatusMap,
	ReviewerDefinition,
	ReviewerMeta,
	ReviewerRenderArgs,
	ReviewerRenderCandidate,
	ReviewerRenderContext,
	Rule,
	Severity,
} from "./core/types";
export {
	defineReviewer,
	SEVERITY_EMOJI,
	SEVERITY_ORDER,
	severityRank,
} from "./core/types";
