/**
 * Orquestração do harness local (`houndsman hunt`).
 *
 * Recebe os briefs já preparados e despacha um processo maki por watchdog. O
 * watchdog devolve o JSON na resposta final; validamos com o mesmo parser do
 * `--finalize` e gravamos em `findings/<id>.json`. Falhas são reportadas por
 * watchdog — a política de finalizar ou não fica com o chamador (CLI).
 */

import { readFileSync } from "node:fs";
import { GENERAL_WATCHDOG_ID } from "../builtins";
import { type BusinessSummary, parseBusinessSummary } from "../business-summary";
import { parseWatchdogReport } from "../report-builder";
import { systemClock } from "../services/clock";
import type { ReviewWorkArea } from "../storage/work-area";
import { renderHuntIntentPrompt, renderIntentRetrySuffix } from "./maki-intent-prompt";
import { renderHuntPrompt, renderRetrySuffix } from "./maki-prompt";
import {
	extractJsonObject,
	type MakiProcessRunner,
	type MakiRunMetrics,
	type MakiUsage,
} from "./maki-runner";
import { mapPool } from "./pool";

/** Evento de progresso (CLI loga; core não escreve saída). */
export type HuntEvent =
	| {
			type: "intent";
			status: "start" | "done" | "skipped" | "failed";
			source?: BusinessSummary["source"];
			error?: string;
	  }
	| { type: "start"; watchdogId: string }
	| {
			type: "retry";
			watchdogId: string;
			attempt: number;
			maxAttempts: number;
			error: string;
	  }
	| {
			type: "done";
			watchdogId: string;
			findings: number;
			reviewedFiles: number;
			attempts: number;
			metrics: MakiRunMetrics;
	  }
	| {
			type: "failed";
			watchdogId: string;
			error: string;
			attempts: number;
			metrics: MakiRunMetrics;
	  };

/** Resultado de um watchdog. */
export type HuntWatchdogResult = {
	watchdogId: string;
	status: "done" | "failed";
	findings: number;
	reviewedFiles: number;
	attempts: number;
	durationMs: number;
	sessionId?: string;
	numTurns?: number;
	costUsd?: number;
	usage?: MakiUsage;
	error?: string;
};

/** Agregados do relatório. */
export type HuntTotals = {
	watchdogs: number;
	done: number;
	failed: number;
	findings: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

/** Relatório persistido como `hunt-report.json`. */
export type HuntReport = {
	version: 1;
	engine: "maki";
	model: string;
	/** Fonte do modelo de intenção usado na revisão. */
	business?: BusinessSummary["source"];
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	watchdogs: HuntWatchdogResult[];
	totals: HuntTotals;
};

/** Dependências do runner. */
export type HuntRunnerOptions = {
	/** Staging da review (briefs/findings). */
	work: ReviewWorkArea;
	/** Raiz de leitura dos arquivos da review. */
	root: string;
	projectName: string;
	/** Spec `provider/model-id`. */
	model: string;
	apiKeyEnv: string;
	apiKey: string;
	concurrency: number;
	timeoutMs: number;
	retries: number;
	runner: MakiProcessRunner;
	onEvent?: (event: HuntEvent) => void;
};

/** Despacha os briefs via maki e devolve o relatório consolidado. */
export class HuntRunner {
	private readonly options: HuntRunnerOptions;

	constructor(options: HuntRunnerOptions) {
		this.options = options;
	}

	async run(activeIds: readonly string[]): Promise<HuntReport> {
		const startedAt = systemClock();
		const startedMs = Date.now();
		// Intenção primeiro: o revisor `general` e os demais watchdogs leem o
		// mesmo `business-summary.json` do staging.
		const business = await this.runIntent();
		const watchdogs = await mapPool(activeIds, this.options.concurrency, (id) =>
			this.runOne(id),
		);
		const finishedAt = systemClock();
		return {
			version: 1,
			engine: "maki",
			model: this.options.model,
			business,
			startedAt,
			finishedAt,
			durationMs: Date.now() - startedMs,
			watchdogs,
			totals: totalsOf(watchdogs),
		};
	}

	/**
	 * Pré-passe de intenção (IA embutida). Pula quando o prepare já gerou o
	 * modelo com IA; falha mantém o determinístico (fail-open).
	 */
	private async runIntent(): Promise<BusinessSummary["source"] | undefined> {
		const existing = this.options.work.readBusinessSummary();
		if (existing?.source === "ai") {
			this.emit({ type: "intent", status: "skipped", source: "ai" });
			return "ai";
		}

		let brief: string;
		try {
			brief = readFileSync(this.options.work.businessPaths.brief, "utf8");
		} catch {
			return existing?.source;
		}

		this.emit({ type: "intent", status: "start" });
		const basePrompt = renderHuntIntentPrompt({
			projectName: this.options.projectName,
			brief,
		});
		let lastError = "";
		for (let attempt = 0; attempt <= this.options.retries; attempt++) {
			const prompt =
				attempt === 0
					? basePrompt
					: `${basePrompt}\n${renderIntentRetrySuffix(lastError)}`;
			const result = await this.options.runner.run({
				prompt,
				cwd: this.options.root,
				model: this.options.model,
				apiKeyEnv: this.options.apiKeyEnv,
				apiKey: this.options.apiKey,
				timeoutMs: this.options.timeoutMs,
			});
			if (!result.ok) {
				lastError = result.error;
				continue;
			}
			const raw = extractJsonObject(result.text);
			if (raw === null) {
				lastError = "a resposta final não contém um objeto JSON.";
				continue;
			}
			const summary = parseBusinessSummary(
				{ ...raw, source: "reviewer" },
				"reviewer",
			);
			if (!summary) {
				lastError = "JSON fora do schema do modelo de intenção.";
				continue;
			}
			this.options.work.writeBusinessSummary(summary);
			this.emit({ type: "intent", status: "done", source: "reviewer" });
			return "reviewer";
		}

		this.emit({ type: "intent", status: "failed", error: lastError });
		return existing?.source ?? "deterministic";
	}

	private async runOne(watchdogId: string): Promise<HuntWatchdogResult> {
		const briefPath = this.options.work.briefFile(watchdogId);
		let brief: string;
		try {
			brief = readFileSync(briefPath, "utf8");
		} catch {
			const error = `Brief ausente: ${briefPath}`;
			this.emit({
				type: "failed",
				watchdogId,
				error,
				attempts: 0,
				metrics: { durationMs: 0 },
			});
			return failedResult(watchdogId, error, 0, { durationMs: 0 });
		}

		const basePrompt = renderHuntPrompt({
			projectName: this.options.projectName,
			watchdogId,
			brief,
		});

		this.emit({ type: "start", watchdogId });
		let attempts = 0;
		let lastError = "";
		const accumulated: MakiRunMetrics = { durationMs: 0 };

		while (attempts <= this.options.retries) {
			attempts++;
			const prompt =
				attempts === 1
					? basePrompt
					: `${basePrompt}\n${renderRetrySuffix(lastError)}`;
			const result = await this.options.runner.run({
				prompt,
				cwd: this.options.root,
				model: this.options.model,
				apiKeyEnv: this.options.apiKeyEnv,
				apiKey: this.options.apiKey,
				timeoutMs: this.options.timeoutMs,
			});
			mergeMetrics(accumulated, result.metrics);

			if (!result.ok) {
				lastError = result.error;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			const raw = extractJsonObject(result.text);
			if (raw === null) {
				lastError = "a resposta final não contém um objeto JSON.";
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			const warnings: string[] = [];
			const report = parseWatchdogReport(raw, `maki:${watchdogId}`, (message) =>
				warnings.push(message),
			);
			if (!report) {
				lastError = warnings[0] ?? "JSON fora do schema do watchdog.";
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}
			if (report.watchdogId !== watchdogId) {
				lastError = `watchdogId '${report.watchdogId}' não corresponde a '${watchdogId}'.`;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			// O revisor de fluxo devolve o modelo de intenção no JSON (maki não escreve).
			if (watchdogId === GENERAL_WATCHDOG_ID) {
				const summary = (raw as Record<string, unknown>).businessSummary;
				if (typeof summary === "object" && summary !== null) {
					const parsed = parseBusinessSummary(
						{ ...(summary as Record<string, unknown>), source: "reviewer" },
						"reviewer",
					);
					if (parsed) this.options.work.writeBusinessSummary(parsed);
				}
			}

			this.options.work.writeFinding(
				watchdogId,
				`${JSON.stringify(report, null, 2)}\n`,
			);
			const done: HuntWatchdogResult = {
				watchdogId,
				status: "done",
				findings: report.findings.length,
				reviewedFiles: report.reviewedFiles.length,
				attempts,
				durationMs: accumulated.durationMs,
				sessionId: accumulated.sessionId,
				numTurns: accumulated.numTurns,
				costUsd: accumulated.costUsd,
				usage: accumulated.usage,
			};
			this.emit({
				type: "done",
				watchdogId,
				findings: done.findings,
				reviewedFiles: done.reviewedFiles,
				attempts,
				metrics: accumulated,
			});
			return done;
		}

		const error = lastError || "falha desconhecida.";
		this.emit({ type: "failed", watchdogId, error, attempts, metrics: accumulated });
		return failedResult(watchdogId, error, attempts, accumulated);
	}

	private emit(event: HuntEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Avisa a próxima tentativa (só quando ainda há retry). */
	private emitRetry(watchdogId: string, attempt: number, error: string): void {
		if (attempt > this.options.retries) return;
		this.emit({
			type: "retry",
			watchdogId,
			attempt,
			maxAttempts: this.options.retries + 1,
			error,
		});
	}
}

/** Soma métricas de várias tentativas no acumulado. */
function mergeMetrics(target: MakiRunMetrics, source: MakiRunMetrics): void {
	target.durationMs += source.durationMs;
	target.sessionId = source.sessionId ?? target.sessionId;
	if (source.numTurns !== undefined) {
		target.numTurns = (target.numTurns ?? 0) + source.numTurns;
	}
	if (source.costUsd !== undefined) {
		target.costUsd = (target.costUsd ?? 0) + source.costUsd;
	}
	if (source.usage) {
		target.usage = {
			inputTokens:
				(target.usage?.inputTokens ?? 0) + (source.usage.inputTokens ?? 0),
			outputTokens:
				(target.usage?.outputTokens ?? 0) + (source.usage.outputTokens ?? 0),
			totalTokens:
				(target.usage?.totalTokens ?? 0) + (source.usage.totalTokens ?? 0),
			cacheReadInputTokens:
				(target.usage?.cacheReadInputTokens ?? 0) +
				(source.usage.cacheReadInputTokens ?? 0),
		};
	}
}

/** Resultado de falha de um watchdog. */
function failedResult(
	watchdogId: string,
	error: string,
	attempts: number,
	metrics: MakiRunMetrics,
): HuntWatchdogResult {
	return {
		watchdogId,
		status: "failed",
		findings: 0,
		reviewedFiles: 0,
		attempts,
		durationMs: metrics.durationMs,
		sessionId: metrics.sessionId,
		numTurns: metrics.numTurns,
		costUsd: metrics.costUsd,
		usage: metrics.usage,
		error,
	};
}

/** Agrega os resultados por watchdog. */
function totalsOf(watchdogs: readonly HuntWatchdogResult[]): HuntTotals {
	const totals: HuntTotals = {
		watchdogs: watchdogs.length,
		done: 0,
		failed: 0,
		findings: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
	for (const watchdog of watchdogs) {
		if (watchdog.status === "done") totals.done++;
		else totals.failed++;
		totals.findings += watchdog.findings;
		totals.costUsd += watchdog.costUsd ?? 0;
		totals.inputTokens += watchdog.usage?.inputTokens ?? 0;
		totals.outputTokens += watchdog.usage?.outputTokens ?? 0;
		totals.totalTokens += watchdog.usage?.totalTokens ?? 0;
	}
	totals.costUsd = Number(totals.costUsd.toFixed(6));
	return totals;
}
