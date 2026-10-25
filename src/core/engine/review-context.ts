/**
 * Contexto de uma run (engine) — storage + review + staging + raiz operacional.
 *
 * É criado uma vez por `ReviewSession` e injetado nas pipelines. Não existe
 * contexto ambiente: duas runs concorrentes no mesmo processo mantêm contextos
 * isolados (um singleton mutável trocaria root/git/storage entre `await`s).
 */

import { GitRepository } from "../services/git-repository";
import { ProjectFiles } from "../services/project-files";
import type { ReviewRecord, StorageProvider } from "../storage/types";
import { ReviewWorkArea } from "../storage/work-area";

/** Workspace onde os arquivos da review são lidos. */
export type ReviewWorkspaceContext = {
	/** Raiz operacional (worktree ou clone principal). */
	root?: string;
	/** Raiz do clone principal (identidade/config). */
	mainRoot?: string;
	git?: GitRepository;
};

/** Contexto de uma run: storage + review + staging + raiz operacional. */
export type ReviewContext = {
	storage: StorageProvider;
	review: ReviewRecord;
	work: ReviewWorkArea;
	root: string;
	mainRoot: string;
	git: GitRepository;
	/** Leitor relativo à raiz operacional (evita repetir `fileReader(root)`). */
	files: ProjectFiles;
};

/** Cria o contexto de uma review existente. */
export function reviewContext(
	storage: StorageProvider,
	review: ReviewRecord,
	workspace: ReviewWorkspaceContext = {},
): ReviewContext {
	const root = workspace.root ?? process.cwd();
	return {
		storage,
		review,
		work: new ReviewWorkArea(review),
		root,
		mainRoot: workspace.mainRoot ?? root,
		git: workspace.git ?? new GitRepository(),
		files: new ProjectFiles(root),
	};
}
