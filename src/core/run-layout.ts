/**
 * Layout de uma run (biblioteca) — único ponto que conhece os nomes/estrutura
 * dos artefatos em `.houndsman/.runs/<slug>/`.
 *
 * Evita o "data clump" de `(dir, branch)`/`(outDir, branch)` espalhado pelo
 * motor: quem precisa de um caminho pede ao layout.
 */

import { join } from "node:path";
import {
	CONTEXT_BRIEF_FILE,
	CONTEXT_FILE,
	CONTEXT_SUMMARY_FILE,
	RUN_STATUS_FILE,
	STATE_FILE,
	VERIFY_FILE,
} from "./paths";
import { sanitizeBranch } from "./report-builder";

/** Caminhos dos artefatos de contexto da PR. */
export type ContextPaths = {
	dir: string;
	context: string;
	summary: string;
	brief: string;
};

/** Diretório e caminhos de uma run (branch-slug). */
export class RunLayout {
	readonly artifactDir: string;
	readonly branch: string;

	constructor(artifactDir: string, branch: string) {
		this.artifactDir = artifactDir;
		this.branch = branch;
	}

	get slug(): string {
		return sanitizeBranch(this.branch);
	}

	get outDir(): string {
		return join(this.artifactDir, this.slug);
	}

	get briefsDir(): string {
		return join(this.outDir, "briefs");
	}

	get findingsDir(): string {
		return join(this.outDir, "findings");
	}

	/** Caminho de um arquivo dentro da pasta da run. */
	file(name: string): string {
		return join(this.outDir, name);
	}

	briefFile(id: string): string {
		return join(this.briefsDir, `${id}.md`);
	}

	findingFile(id: string): string {
		return join(this.findingsDir, `${id}.json`);
	}

	get classificationFile(): string {
		return this.file("classification.json");
	}

	get manifestFile(): string {
		return this.file("manifest.json");
	}

	get candidatesFile(): string {
		return this.file("candidates.json");
	}

	get reviewFile(): string {
		return this.file("review.md");
	}

	get stateFile(): string {
		return this.file(STATE_FILE);
	}

	get runStatusFile(): string {
		return this.file(RUN_STATUS_FILE);
	}

	get verifyFile(): string {
		return this.file(VERIFY_FILE);
	}

	/** Relatório isolado de um watchdog (`review.<id>.md`). */
	domainReportFile(id: string): string {
		return this.file(`review.${sanitizeBranch(id)}.md`);
	}

	get contextPaths(): ContextPaths {
		return {
			dir: this.outDir,
			context: this.file(CONTEXT_FILE),
			summary: this.file(CONTEXT_SUMMARY_FILE),
			brief: this.file(CONTEXT_BRIEF_FILE),
		};
	}
}
