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
import { parseWatchdogReport, type WatchdogReport } from "../report-builder";
import { systemClock } from "../services/clock";
import type { ReviewWorkArea } from "../storage/work-area";
import { renderHuntIntentPrompt, renderIntentRetrySuffix } from "./maki-intent-prompt";
import {
	renderChecklistSuffix,
	renderHuntPrompt,
	renderResumeSuffix,
	renderRetrySuffix,
} from "./maki-prompt";
import {
	extractJsonObject,
	type MakiProcessRunner,
	type MakiRunMetrics,
	type MakiUsage,
} from "./maki-runner";
import { mapPool } from "./pool";
import {
	briefDomainFiles,
	businessScore,
	type CheckCoverage,
	chooseBusinessSummary,
	expectedReviewItems,
	mergeChecks,
	mergeFindings,
	missingReviewItems,
	normalizePath,
	parseReviewChecks,
	type ReviewCheck,
	summarizeChecks,
	withInferredRule,
} from "./review-checks";

/** Evento de progresso (CLI loga; core não escreve saída). */
export type HuntEvent =
	| {
			type: "intent";
			status: "start" | "done" | "skipped" | "failed";
			source?: BusinessSummary["source"];
			error?: string;
	  }
	| {
			type: "checklist";
			watchdogId: string;
			missing: number;
			status: "start" | "done" | "failed";
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
	/** Cobertura do checklist de intenção (fluxos + invariantes). */
	checks?: CheckCoverage;
	/** Cobertura declarada dos arquivos do domínio (`reviewedFiles` ∪ `skipped`). */
	coverage?: {
		total: number;
		reviewed: number;
		skipped: number;
		undeclared: number;
	};
	/** Decisão sobre o modelo de intenção devolvido pelo `general`. */
	business?: {
		accepted: boolean;
		source: BusinessSummary["source"];
		score: number;
	};
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
	/** Pontuação do modelo de intenção efetivo (fluxos/invariantes/contratos). */
	businessScore?: number;
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
	/**
	 * Passada extra por watchdog quando o checklist de intenção não foi coberto
	 * (default: ligada). Desligue com `hunt.checklist: false`.
	 */
	checklist?: boolean;
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
		const businessSource = await this.runIntent();
		// Snapshot único: o `general` pode devolver outro modelo no meio da onda;
		// os demais watchdogs precisam do mesmo contrato do brief que receberam.
		const businessModel = this.options.work.readBusinessSummary();
		const watchdogs = await mapPool(activeIds, this.options.concurrency, (id) =>
			this.runOne(id, businessModel),
		);
		const finishedAt = systemClock();
		const effective = this.options.work.readBusinessSummary();
		return {
			version: 1,
			engine: "maki",
			model: this.options.model,
			business: effective?.source ?? businessSource,
			businessScore: effective ? businessScore(effective) : undefined,
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
			// Modelo sem fluxo nem invariante não sustenta a revisão por
			// invariantes: repete em vez de degradar os briefs.
			if (
				summary.flows.length === 0 &&
				summary.invariants.length + summary.contracts.length < 2
			) {
				lastError =
					"modelo de intenção sem fluxos e com menos de 2 invariantes/contratos.";
				continue;
			}
			const decision = chooseBusinessSummary(
				this.options.work.readBusinessSummary(),
				summary,
			);
			if (!decision.accepted || !decision.summary) {
				lastError = "modelo de intenção inferior ao já disponível.";
				continue;
			}
			this.options.work.writeBusinessSummary(decision.summary);
			this.emit({ type: "intent", status: "done", source: "reviewer" });
			return "reviewer";
		}

		this.emit({ type: "intent", status: "failed", error: lastError });
		return existing?.source ?? "deterministic";
	}

	private async runOne(
		watchdogId: string,
		business: BusinessSummary | null,
	): Promise<HuntWatchdogResult> {
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
		// Checklist derivado do modelo de intenção: cada fluxo/invariante do brief
		// precisa de uma verificação declarada, não só de um diff lido.
		const expected = expectedReviewItems(brief, business, watchdogId);

		this.emit({ type: "start", watchdogId });
		let attempts = 0;
		const accumulated: MakiRunMetrics = { durationMs: 0 };

		const first = await this.executePass(watchdogId, basePrompt);
		mergeMetrics(accumulated, first.metrics);
		attempts += first.attempts;
		if (!first.ok) {
			this.emit({
				type: "failed",
				watchdogId,
				error: first.error,
				attempts,
				metrics: accumulated,
			});
			return failedResult(watchdogId, first.error, attempts, accumulated);
		}

		let report = first.report;
		let checks = first.checks;
		let reviewerBusiness = first.reviewerBusiness;

		const missing = missingReviewItems(expected, checks);
		if (this.options.checklist !== false && missing.length > 0) {
			this.emit({
				type: "checklist",
				watchdogId,
				missing: missing.length,
				status: "start",
			});
			const second = await this.executePass(
				watchdogId,
				`${basePrompt}\n${renderChecklistSuffix(missing)}`,
			);
			mergeMetrics(accumulated, second.metrics);
			attempts += second.attempts;
			if (second.ok) {
				// A segunda passada não pode *perder* achados: une as duas.
				report = mergeReport(report, second.report);
				checks = mergeChecks(checks, second.checks);
				reviewerBusiness = richerBusiness(
					reviewerBusiness,
					second.reviewerBusiness,
				);
				this.emit({
					type: "checklist",
					watchdogId,
					missing: missingReviewItems(expected, checks).length,
					status: "done",
				});
			} else {
				this.emit({
					type: "checklist",
					watchdogId,
					missing: missing.length,
					status: "failed",
					error: second.error,
				});
			}
		}

		const businessDecision = this.applyReviewerBusiness(watchdogId, reviewerBusiness);

		// `rule` vazio quebra a identidade do finding na triagem; infere pelo
		// prefixo do `basis` + primeira frase da mensagem.
		report = withInferredRule(report);
		this.options.work.writeFinding(
			watchdogId,
			`${JSON.stringify({ ...report, checks }, null, 2)}\n`,
		);
		const coverage = summarizeChecks(expected, checks);
		const files = coverageOf(brief, report);
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
			checks: coverage.expected > 0 ? coverage : undefined,
			coverage: files.total > 0 ? files : undefined,
			business: businessDecision,
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

	/** Uma passada do brief, com as retentativas de saída inválida. */
	private async executePass(
		watchdogId: string,
		basePrompt: string,
	): Promise<PassOutcome> {
		let attempts = 0;
		let lastError = "";
		/** A última tentativa chegou a produzir resposta? (permite retomar a sessão) */
		let canResume = false;
		const metrics: MakiRunMetrics = { durationMs: 0 };

		while (attempts <= this.options.retries) {
			attempts++;
			const resume = attempts > 1 && canResume ? metrics.sessionId : undefined;
			const prompt =
				attempts === 1
					? basePrompt
					: resume
						? renderResumeSuffix(lastError, watchdogId)
						: `${basePrompt}\n${renderRetrySuffix(lastError)}`;
			const result = await this.options.runner.run({
				prompt,
				cwd: this.options.root,
				model: this.options.model,
				apiKeyEnv: this.options.apiKeyEnv,
				apiKey: this.options.apiKey,
				resume,
				timeoutMs: this.options.timeoutMs,
			});
			mergeMetrics(metrics, result.metrics);

			if (!result.ok) {
				lastError = result.error;
				canResume = false;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			const raw = extractJsonObject(result.text);
			if (raw === null) {
				lastError = "a resposta final não contém um objeto JSON.";
				canResume = true;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			const warnings: string[] = [];
			const report = parseWatchdogReport(raw, `maki:${watchdogId}`, (message) =>
				warnings.push(message),
			);
			if (!report) {
				lastError = warnings[0] ?? "JSON fora do schema do watchdog.";
				canResume = true;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}
			if (report.watchdogId !== watchdogId) {
				lastError = `watchdogId '${report.watchdogId}' não corresponde a '${watchdogId}'.`;
				canResume = true;
				this.emitRetry(watchdogId, attempts, lastError);
				continue;
			}

			return {
				ok: true,
				report,
				checks: parseReviewChecks(raw),
				// O revisor de fluxo devolve o modelo de intenção no JSON.
				reviewerBusiness:
					watchdogId === GENERAL_WATCHDOG_ID
						? reviewerBusinessOf(raw)
						: undefined,
				attempts,
				metrics,
			};
		}

		return {
			ok: false,
			error: lastError || "falha desconhecida.",
			attempts,
			metrics,
		};
	}

	/**
	 * Aplica o modelo devolvido pelo `general` somente se ele for mais rico que
	 * o já gravado — o revisor reconstrói a intenção sem ver o JSON inteiro e já
	 * substituiu um modelo da IA (5 fluxos) por um resumo sem fluxos.
	 */
	private applyReviewerBusiness(
		watchdogId: string,
		incoming: BusinessSummary | undefined,
	): HuntWatchdogResult["business"] {
		if (watchdogId !== GENERAL_WATCHDOG_ID || !incoming) return undefined;
		const decision = chooseBusinessSummary(
			this.options.work.readBusinessSummary(),
			incoming,
		);
		if (decision.accepted && decision.summary) {
			this.options.work.writeBusinessSummary(decision.summary);
		}
		return {
			accepted: decision.accepted,
			source: decision.summary?.source ?? incoming.source,
			score: businessScore(incoming),
		};
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

/** Resultado de uma passada do brief (com retries internos). */
type PassOutcome =
	| {
			ok: true;
			report: WatchdogReport;
			checks: ReviewCheck[];
			reviewerBusiness?: BusinessSummary;
			attempts: number;
			metrics: MakiRunMetrics;
	  }
	| { ok: false; error: string; attempts: number; metrics: MakiRunMetrics };

/** Modelo de intenção que o `general` devolve no JSON (se válido). */
function reviewerBusinessOf(raw: unknown): BusinessSummary | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const summary = (raw as Record<string, unknown>).businessSummary;
	if (typeof summary !== "object" || summary === null) return undefined;
	return (
		parseBusinessSummary(
			{ ...(summary as Record<string, unknown>), source: "reviewer" },
			"reviewer",
		) ?? undefined
	);
}

/** Une as duas passadas: achados por chave, cobertura declarada por união. */
function mergeReport(first: WatchdogReport, second: WatchdogReport): WatchdogReport {
	return {
		watchdogId: first.watchdogId,
		reviewedFiles: [...new Set([...first.reviewedFiles, ...second.reviewedFiles])],
		skipped: [...new Set([...first.skipped, ...second.skipped])],
		findings: mergeFindings(first.findings, second.findings),
	};
}

/** Cobertura declarada dos arquivos do domínio do brief. */
function coverageOf(
	brief: string,
	report: WatchdogReport,
): { total: number; reviewed: number; skipped: number; undeclared: number } {
	const domain = new Set(briefDomainFiles(brief));
	if (domain.size === 0) return { total: 0, reviewed: 0, skipped: 0, undeclared: 0 };
	const reviewed = new Set(
		report.reviewedFiles.map(normalizePath).filter((file) => domain.has(file)),
	).size;
	const skipped = new Set(
		report.skipped
			.map(declaredPath)
			.filter((file): file is string => file !== null && domain.has(file)),
	).size;
	return {
		total: domain.size,
		reviewed,
		skipped,
		undeclared: Math.max(0, domain.size - reviewed - skipped),
	};
}

/** Primeiro caminho de arquivo citado numa entrada de `skipped` (ou null). */
function declaredPath(entry: string): string | null {
	const match = entry.match(/[\w./-]+\.[A-Za-z0-9]{1,5}/);
	return match ? normalizePath(match[0]) : null;
}

/** Modelo de intenção mais rico entre duas passadas. */
function richerBusiness(
	first: BusinessSummary | undefined,
	second: BusinessSummary | undefined,
): BusinessSummary | undefined {
	if (!second) return first;
	if (!first) return second;
	return businessScore(second) > businessScore(first) ? second : first;
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
