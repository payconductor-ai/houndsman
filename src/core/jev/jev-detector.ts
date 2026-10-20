/**
 * Detector de candidatos (Passo 1.5) — roda as perguntas Jev por arquivo.
 *
 * Para cada arquivo revisável: monta o `state` (topo do arquivo + hunk do diff),
 * reúne as perguntas dos watchdogs do arquivo e consulta o modelo. Respostas
 * `noul` acima do limiar viram candidatos.
 *
 * Falha-aberto: erro por arquivo é registrado em `skipped` e não interrompe.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectDiff, type DiffSource } from "../diff-source";
import type { ClassificationResult } from "../file-classifier";
import type { WatchdogMeta } from "../types";
import {
	type JevCandidate,
	JevCandidatesStore,
	type JevSkippedFile,
} from "./jev-candidates";
import type { JevClient } from "./jev-client";
import { type DerivedQuestion, JevQuestionFactory } from "./jev-questions";
import type { JevQuestion } from "./jev-types";

export type DetectOptions = {
	/** Limiar de confiança (`noul`) para virar candidato. */
	threshold?: number;
	/** Nº de arquivos avaliados em paralelo. */
	concurrency?: number;
	/** Diff já coletado (evita novo `git diff`); ausente → coleta aqui. */
	diff?: DiffSource;
};

export type DetectResult = {
	candidates: JevCandidate[];
	skipped: JevSkippedFile[];
	analyzedFiles: number;
	model?: string;
};

/** Orquestra a pré-análise Jev sobre um diff classificado. */
export class JevDetector {
	/** Linhas iniciais do arquivo (imports/declarações) incluídas no `state`. */
	private static readonly HEADER_LINES = 60;
	private static readonly MAX_STATE_CHARS = 8_000;
	private static readonly MAX_DIFF_CHARS = 4_000;
	private static readonly DEFAULT_CONCURRENCY = 5;

	private readonly client: JevClient;
	private readonly questions: JevQuestionFactory;
	/** Raiz dos arquivos (worktree ou clone principal). */
	private readonly root: string;

	/** Construtor que recebe o cliente e o registry de watchdogs (injeção). */
	constructor(
		client: JevClient,
		registry: Record<string, WatchdogMeta>,
		root: string = process.cwd(),
	) {
		this.client = client;
		this.questions = new JevQuestionFactory(registry);
		this.root = root;
	}

	/** Roda a pré-análise e devolve os candidatos (ordenados por confiança desc). */
	async detect(
		classification: ClassificationResult,
		base: string,
		head: string,
		options: DetectOptions = {},
	): Promise<DetectResult> {
		const threshold = options.threshold ?? JevCandidatesStore.THRESHOLD;
		const concurrency = options.concurrency ?? JevDetector.DEFAULT_CONCURRENCY;
		const diff = this.resolveDiff(base, head, options.diff);

		const jobs = this.buildJobs(classification);
		const questionByKey = new Map<string, DerivedQuestion>();
		for (const job of jobs) {
			for (const dq of job.questions) questionByKey.set(dq.key, dq);
		}

		const candidates: JevCandidate[] = [];
		const skipped: JevSkippedFile[] = [];
		let model: string | undefined;

		await JevDetector.mapWithConcurrency(jobs, concurrency, async (job) => {
			const questions: Record<string, JevQuestion> = {};
			for (const dq of job.questions) questions[dq.key] = dq.question;

			const status = classification.files[job.file]?.status ?? "modified";
			const state = this.buildState(job.file, status, diff);

			try {
				const response = await this.client.evaluate({ state, questions });
				model ??= response.model;
				for (const [key, answer] of Object.entries(response.answers)) {
					if (answer.type !== "noul" || answer.noul < threshold) continue;
					const dq = questionByKey.get(key);
					if (!dq) continue;
					candidates.push({
						watchdogId: dq.watchdogId,
						rule: dq.rule,
						severity: dq.severity,
						file: job.file,
						confidence: answer.noul,
						questionKey: key,
					});
				}
			} catch (error) {
				skipped.push({
					file: job.file,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		});

		candidates.sort((a, b) => b.confidence - a.confidence);

		return {
			candidates,
			skipped,
			analyzedFiles: jobs.length,
			model,
		};
	}

	/** Arquivo → perguntas dos watchdogs que o cobrem (só arquivos com perguntas). */
	private buildJobs(
		classification: ClassificationResult,
	): { file: string; questions: DerivedQuestion[] }[] {
		const filesToWatchdogs = JevDetector.mapFilesToWatchdogs(classification);
		return [...filesToWatchdogs.entries()]
			.map(([file, watchdogs]) => ({
				file,
				questions: this.questions.build([...watchdogs]),
			}))
			.filter((job) => job.questions.length > 0);
	}

	/**
	 * Diff para o `state`: reaproveita o injetado ou coleta **uma vez**. Tolerante
	 * a falha — o Jev é opcional/fail-open.
	 */
	private resolveDiff(base: string, head: string, provided?: DiffSource): DiffSource {
		if (provided) return provided;
		try {
			return collectDiff(base, head);
		} catch {
			return { byFile: new Map<string, string>(), churn: new Map() };
		}
	}

	/** Monta o `state` de um arquivo: cabeçalho + hunk do diff, com cap de tamanho. */
	private buildState(filePath: string, status: string, diff: DiffSource): string {
		const header = this.readHeader(filePath);
		const hunk =
			diff.byFile.get(filePath)?.slice(0, JevDetector.MAX_DIFF_CHARS) ?? "";
		const parts = [`Arquivo: ${filePath} (${status})`];
		if (header) {
			parts.push("--- topo do arquivo (imports/declarações) ---", header);
		}
		if (hunk) parts.push("--- diff ---", hunk);
		return parts.join("\n").slice(0, JevDetector.MAX_STATE_CHARS);
	}

	private readHeader(filePath: string): string {
		try {
			return readFileSync(join(this.root, filePath), "utf8")
				.split("\n")
				.slice(0, JevDetector.HEADER_LINES)
				.join("\n");
		} catch {
			return "";
		}
	}

	/** Arquivo → watchdogs que o cobrem. */
	private static mapFilesToWatchdogs(
		classification: ClassificationResult,
	): Map<string, Set<string>> {
		const map = new Map<string, Set<string>>();
		for (const [id, files] of Object.entries(classification.watchdogs)) {
			for (const file of files ?? []) {
				let set = map.get(file);
				if (!set) {
					set = new Set<string>();
					map.set(file, set);
				}
				set.add(id);
			}
		}
		return map;
	}

	/** Executa `fn` sobre `items` com concorrência limitada (ordem irrelevante). */
	private static async mapWithConcurrency<T>(
		items: readonly T[],
		limit: number,
		fn: (item: T) => Promise<void>,
	): Promise<void> {
		let cursor = 0;
		const workers = Array.from(
			{ length: Math.min(limit, items.length) },
			async () => {
				while (cursor < items.length) {
					const current = items[cursor++];
					await fn(current);
				}
			},
		);
		await Promise.all(workers);
	}
}
