/**
 * Área de trabalho (staging) de uma review — biblioteca.
 *
 * O banco é a fonte de verdade de reviews/findings/artefatos. Este diretório
 * guarda só o que os subagentes leem e escrevem: briefs, findings brutos e o
 * contexto da PR. Vive em `<HOUNDSMAN_HOME>/work/<reviewId>/` e é limpo após o
 * `finalize`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONTEXT_BRIEF_FILE,
	CONTEXT_FILE,
	CONTEXT_SUMMARY_FILE,
	displayPath,
} from "../paths";
import type { ContextPaths } from "../pr-context";
import {
	type ContextSummary,
	parseContextSummary,
	parseWatchdogReport,
	type WatchdogReport,
} from "../report-builder";
import { systemClock } from "../services/clock";
import { workRoot } from "./paths";
import type { ReviewRecord } from "./types";

export type { ContextPaths };

/** Resultado da leitura dos findings brutos de uma rodada. */
export type FindingsIngest = {
	reports: WatchdogReport[];
	pending: string[];
	warnings: string[];
};

/** Staging de uma review (briefs/findings/contexto). */
export class ReviewWorkArea {
	readonly review: ReviewRecord;
	readonly root: string;

	constructor(review: ReviewRecord, base: string = workRoot()) {
		this.review = review;
		this.root = join(base, review.id);
	}

	get branch(): string {
		return this.review.branch;
	}

	get slug(): string {
		return this.review.slug;
	}

	get briefsDir(): string {
		return join(this.root, "briefs");
	}

	get findingsDir(): string {
		return join(this.root, "findings");
	}

	/** Caminho de um arquivo dentro da área de trabalho. */
	file(name: string): string {
		return join(this.root, name);
	}

	briefFile(id: string): string {
		return join(this.briefsDir, `${id}.md`);
	}

	findingFile(id: string): string {
		return join(this.findingsDir, `${id}.json`);
	}

	get contextPaths(): ContextPaths {
		return {
			dir: this.root,
			context: this.file(CONTEXT_FILE),
			summary: this.file(CONTEXT_SUMMARY_FILE),
			brief: this.file(CONTEXT_BRIEF_FILE),
		};
	}

	/** Garante os diretórios; `clean` recria a área do zero. */
	ensure(clean = false): void {
		if (clean) this.clean();
		mkdirSync(this.briefsDir, { recursive: true });
		mkdirSync(this.findingsDir, { recursive: true });
	}

	/** Remove todo o staging da review. */
	clean(): void {
		rmSync(this.root, { recursive: true, force: true });
	}

	/** Remove só os findings brutos (equivalente ao antigo `--clean`). */
	cleanFindings(): void {
		rmSync(this.findingsDir, { recursive: true, force: true });
		mkdirSync(this.findingsDir, { recursive: true });
	}

	writeBrief(id: string, content: string): void {
		mkdirSync(this.briefsDir, { recursive: true });
		writeFileSync(this.briefFile(id), content);
	}

	/** Grava o relatório JSON de um watchdog (staging dos subagentes). */
	writeFinding(id: string, content: string): void {
		mkdirSync(this.findingsDir, { recursive: true });
		writeFileSync(this.findingFile(id), content);
	}

	writeContext(context: unknown, brief: string): void {
		mkdirSync(this.root, { recursive: true });
		writeFileSync(this.contextPaths.context, `${JSON.stringify(context, null, 2)}\n`);
		writeFileSync(this.contextPaths.brief, `${brief}\n`);
	}

	/** Grava o resumo do contexto (gerado pelo subagente ou pela IA). */
	writeContextSummary(summary: unknown): void {
		mkdirSync(this.root, { recursive: true });
		writeFileSync(this.contextPaths.summary, `${JSON.stringify(summary, null, 2)}\n`);
	}

	/** Finds brutos gravados pelos subagentes (um JSON por watchdog). */
	readFindings(activeIds: string[]): FindingsIngest {
		const reports: WatchdogReport[] = [];
		const pending: string[] = [];
		const warnings: string[] = [];
		for (const id of activeIds) {
			const path = this.findingFile(id);
			if (!existsSync(path)) {
				pending.push(id);
				continue;
			}
			try {
				const raw = JSON.parse(readFileSync(path, "utf8"));
				const report = parseWatchdogReport(raw, path, (message) =>
					warnings.push(message),
				);
				if (report) reports.push(report);
				else pending.push(id);
			} catch (err) {
				warnings.push(
					`[houndsman] ${displayPath(path)} inválido: ${err instanceof Error ? err.message : err}`,
				);
				pending.push(id);
			}
		}
		return { reports, pending, warnings };
	}

	/** Resumo do contexto gravado pelo subagente (null se ausente/inválido). */
	readContextSummary(): ContextSummary | null {
		const path = this.contextPaths.summary;
		if (!existsSync(path)) return null;
		try {
			return parseContextSummary(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			return null;
		}
	}

	/** Conteúdo cru do resumo (para persistir como artefato). */
	readContextSummaryRaw(): string | null {
		const path = this.contextPaths.summary;
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** Contexto bruto da PR (para persistir como artefato). */
	readContextRaw(): string | null {
		const path = this.contextPaths.context;
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** Brief do subagente de contexto (para persistir como artefato). */
	readContextBriefRaw(): string | null {
		const path = this.contextPaths.brief;
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** Toque de `updatedAt` (diagnóstico). */
	touch(): string {
		return systemClock();
	}
}
