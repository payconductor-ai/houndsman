/**
 * Detector de candidatos (Passo 1.5) — roda as perguntas Jev por arquivo.
 *
 * Para cada arquivo revisável: monta o `state` (topo do arquivo + hunk do diff),
 * reúne as perguntas dos revisores do arquivo e consulta o modelo. Respostas
 * `noul` acima do limiar viram candidatos.
 *
 * Falha-aberto: erro por arquivo é registrado em `skipped` e não interrompe.
 */

import { readFileSync } from "node:fs";
import type { ClassificationResult } from "../file-classifier";
import type { ReviewerMeta } from "../types";
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

	/** Construtor que recebe o cliente e o registry de revisores (injeção). */
	constructor(client: JevClient, registry: Record<string, ReviewerMeta>) {
		this.client = client;
		this.questions = new JevQuestionFactory(registry);
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
			const state = this.buildState(job.file, status, base, head);

			try {
				const response = await this.client.evaluate({ state, questions });
				model ??= response.model;
				for (const [key, answer] of Object.entries(response.answers)) {
					if (answer.type !== "noul" || answer.noul < threshold) continue;
					const dq = questionByKey.get(key);
					if (!dq) continue;
					candidates.push({
						reviewerId: dq.reviewerId,
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

	/** Arquivo → perguntas dos revisores que o cobrem (só arquivos com perguntas). */
	private buildJobs(
		classification: ClassificationResult,
	): { file: string; questions: DerivedQuestion[] }[] {
		const filesToReviewers = JevDetector.mapFilesToReviewers(classification);
		return [...filesToReviewers.entries()]
			.map(([file, reviewers]) => ({
				file,
				questions: this.questions.build([...reviewers]),
			}))
			.filter((job) => job.questions.length > 0);
	}

	/** Monta o `state` de um arquivo: cabeçalho + hunk do diff, com cap de tamanho. */
	private buildState(
		filePath: string,
		status: string,
		base: string,
		head: string,
	): string {
		const header = this.readHeader(filePath);
		const hunk = this.readHunk(base, head, filePath);
		const parts = [`Arquivo: ${filePath} (${status})`];
		if (header) {
			parts.push("--- topo do arquivo (imports/declarações) ---", header);
		}
		if (hunk) parts.push("--- diff ---", hunk);
		return parts.join("\n").slice(0, JevDetector.MAX_STATE_CHARS);
	}

	private readHeader(filePath: string): string {
		try {
			return readFileSync(filePath, "utf8")
				.split("\n")
				.slice(0, JevDetector.HEADER_LINES)
				.join("\n");
		} catch {
			return "";
		}
	}

	private readHunk(base: string, head: string, filePath: string): string {
		const result = Bun.spawnSync(
			["git", "diff", `${base}...${head}`, "--", filePath],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (result.exitCode !== 0) return "";
		return new TextDecoder()
			.decode(result.stdout)
			.slice(0, JevDetector.MAX_DIFF_CHARS);
	}

	/** Arquivo → revisores que o cobrem. */
	private static mapFilesToReviewers(
		classification: ClassificationResult,
	): Map<string, Set<string>> {
		const map = new Map<string, Set<string>>();
		for (const [id, files] of Object.entries(classification.reviewers)) {
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
