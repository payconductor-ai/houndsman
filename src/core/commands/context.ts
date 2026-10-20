/**
 * Subcomando `context` — coleta o contexto da PR via `gh` (Passo 0).
 *
 * Biblioteca: grava no staging da review + artefato no storage; o CLI faz o
 * log/exit.
 */

import type { HoundsmanConfig } from "../config";
import {
	collectPrContext,
	currentBranch,
	type PrContextRaw,
	renderContextBrief,
} from "../pr-context";
import { sanitizeBranch } from "../report-builder";
import type { RepoIdentity, StorageProvider } from "../storage/types";
import { type ContextPaths, ReviewWorkArea } from "../storage/work-area";

export type ContextRunResult = {
	paths: ContextPaths;
	context: PrContextRaw;
};

/** Coleta a PR atual e grava `context.json` + `context-brief.md`. */
export function runContextCommand(
	_config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	opts: {
		branch?: string;
		/** Worktree onde a review roda (persistido na review). */
		worktreePath?: string;
		/** PR de origem (persistida na review). */
		prNumber?: number;
	} = {},
): ContextRunResult {
	const branch = opts.branch ?? currentBranch();
	const review = storage.getOrCreateReview({
		repo,
		branch,
		slug: sanitizeBranch(branch),
		worktreePath: opts.worktreePath,
		prNumber: opts.prNumber,
	});
	const work = new ReviewWorkArea(review);
	const paths = work.contextPaths;

	const context = collectPrContext(branch);
	const brief = renderContextBrief(context, branch, paths);
	work.writeContext(context, brief);
	storage.writeArtifact(review.id, {
		name: "context.json",
		kind: "context",
		content: `${JSON.stringify(context, null, 2)}\n`,
	});
	storage.writeArtifact(review.id, {
		name: "context-brief.md",
		kind: "context-brief",
		content: `${brief}\n`,
	});

	return { paths, context };
}
