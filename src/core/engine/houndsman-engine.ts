/**
 * Engine do houndsman (composition root).
 *
 * Injeta a configuração do projeto e os colaboradores compartilhados (git,
 * classificador, verifier, lote). Comandos e pipelines pedem ao engine em vez
 * de instanciar/importar tudo diretamente.
 */

import type { HoundsmanConfig } from "../config";
import type { ReviewOptions } from "../orchestrator";
import { ProjectConfig } from "../project-config";
import { FileClassifier } from "../services/file-classifier";
import { FixBatchBuilder } from "../services/fix-batch-builder";
import { GitRepository } from "../services/git-repository";
import { Verifier } from "../services/verifier";
import { ReviewSession } from "./review-session";

/** Colaboradores injetáveis (testes/CLI). */
export type EngineDeps = {
	git?: GitRepository;
	classifier?: FileClassifier;
	verifier?: Verifier;
	fixBatch?: FixBatchBuilder;
};

/** Composition root do motor. */
export class HoundsmanEngine {
	readonly project: ProjectConfig;
	readonly git: GitRepository;
	readonly classifier: FileClassifier;
	readonly verifier: Verifier;
	readonly fixBatch: FixBatchBuilder;

	constructor(raw: HoundsmanConfig, deps: EngineDeps = {}) {
		this.project = new ProjectConfig(raw);
		this.git = deps.git ?? new GitRepository();
		this.classifier = deps.classifier ?? new FileClassifier(raw);
		this.verifier = deps.verifier ?? new Verifier();
		this.fixBatch = deps.fixBatch ?? new FixBatchBuilder();
	}

	/** Configuração crua (contrato do consumidor). */
	get config(): HoundsmanConfig {
		return this.project.raw;
	}

	/** Abre uma sessão de revisão (prepare/finalize). */
	session(options: ReviewOptions): ReviewSession {
		return ReviewSession.from(this.config, options);
	}
}
