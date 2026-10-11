/**
 * Subcomando `context` — coleta o contexto da PR via `gh` (Passo 0).
 *
 * Biblioteca: grava os artefatos e devolve os dados; o CLI faz o log/exit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { type ReviewConfig, resolveArtifactDir } from "../config";
import {
	type ContextPaths,
	collectPrContext,
	contextPaths,
	currentBranch,
	type PrContextRaw,
	renderContextBrief,
} from "../pr-context";

export type ContextRunResult = {
	paths: ContextPaths;
	context: PrContextRaw;
};

/** Coleta a PR atual e grava `context.json` + `context-brief.md`. */
export function runContextCommand(
	config: ReviewConfig,
	opts: { branch?: string; dir?: string } = {},
): ContextRunResult {
	const branch = opts.branch ?? currentBranch();
	const dir = opts.dir ?? resolveArtifactDir(config);
	const paths = contextPaths(dir, branch);

	mkdirSync(paths.dir, { recursive: true });

	const context = collectPrContext(branch);
	writeFileSync(paths.context, `${JSON.stringify(context, null, 2)}\n`);
	writeFileSync(paths.brief, `${renderContextBrief(context, branch, paths)}\n`);

	return { paths, context };
}
