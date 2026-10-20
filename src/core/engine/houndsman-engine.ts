/**
 * Engine do houndsman (composition root).
 *
 * Injeta a configuração do projeto e os colaboradores compartilhados (git,
 * classificador, verifier, lote). Comandos e pipelines pedem ao engine em vez
 * de instanciar/importar tudo diretamente.
 */

import { resolve } from "node:path";
import { AiClient } from "../ai/ai-client";
import { AstService } from "../ast/service";
import type { HoundsmanConfig } from "../config";
import { createGitRunner } from "../git-runner";
import type { ReviewOptions } from "../orchestrator";
import { ProjectConfig } from "../project-config";
import { FileClassifier } from "../services/file-classifier";
import { FixBatchBuilder } from "../services/fix-batch-builder";
import { GitRepository } from "../services/git-repository";
import { Verifier } from "../services/verifier";
import { createStorage } from "../storage/factory";
import { resolveRepoIdentity } from "../storage/repo-identity";
import type { RepoIdentity, StorageProvider } from "../storage/types";
import { ReviewSession } from "./review-session";
import { mainRootOf } from "./review-workspace";

/** Colaboradores injetáveis (testes/CLI). */
export type EngineDeps = {
	/** Raiz operacional (worktree ou clone principal). */
	root?: string;
	/** Raiz do clone principal (identidade/config). */
	mainRoot?: string;
	git?: GitRepository;
	classifier?: FileClassifier;
	verifier?: Verifier;
	fixBatch?: FixBatchBuilder;
	storage?: StorageProvider;
	repo?: RepoIdentity;
	ast?: AstService;
	ai?: AiClient;
};

/** Composition root do motor. */
export class HoundsmanEngine {
	readonly project: ProjectConfig;
	/** Onde os arquivos da revisão são lidos (worktree ou clone principal). */
	readonly root: string;
	/** Clone principal (identidade estável + camada/config). */
	readonly mainRoot: string;
	readonly git: GitRepository;
	readonly classifier: FileClassifier;
	readonly verifier: Verifier;
	readonly fixBatch: FixBatchBuilder;
	readonly storage: StorageProvider;
	readonly repo: RepoIdentity;
	readonly ast: AstService;
	readonly ai: AiClient;

	constructor(raw: HoundsmanConfig, deps: EngineDeps = {}) {
		this.project = new ProjectConfig(raw);
		this.root = resolve(deps.root ?? process.cwd());
		this.git = deps.git ?? new GitRepository(createGitRunner(this.root));
		this.mainRoot = resolve(
			deps.mainRoot ?? mainRootOf(this.git, this.repoRootFallback()),
		);
		this.classifier = deps.classifier ?? new FileClassifier(raw);
		this.verifier = deps.verifier ?? new Verifier();
		this.fixBatch = deps.fixBatch ?? new FixBatchBuilder();
		this.storage = deps.storage ?? createStorage(raw);
		this.repo =
			deps.repo ??
			resolveRepoIdentity(new GitRepository(createGitRunner(this.mainRoot)));
		this.ast = deps.ast ?? new AstService(raw, this.git, this.root);
		this.ai = deps.ai ?? new AiClient({ project: this.project });
	}

	/** Raiz do clone principal a partir do git atual (fallback: `root`). */
	private repoRootFallback(): string {
		return this.git.rootPath() ?? this.root;
	}

	/** Configuração crua (contrato do consumidor). */
	get config(): HoundsmanConfig {
		return this.project.raw;
	}

	/** Abre uma sessão de revisão (prepare/finalize). */
	session(options: ReviewOptions): ReviewSession {
		return ReviewSession.from(
			this.config,
			options,
			this.storage,
			this.repo,
			this.ast,
			this.ai,
			{ root: this.root, mainRoot: this.mainRoot, git: this.git },
		);
	}

	/** Libera o provider (fecha o SQLite e faz checkpoint do WAL). */
	close(): void {
		this.storage.close();
	}
}
