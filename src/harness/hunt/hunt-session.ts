/**
 * Sessão do hunt nativo: prepare → agentes → finalize.
 *
 * Reutiliza o pipeline determinístico (briefs, classificação, storage) e apenas
 * substitui o "despacho de subagentes" pelo harness.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	type AiUsage,
	type AiUsageRecorder,
	addUsage,
	emptyUsage,
	type ModelProvider,
} from "../../core/ai";
import type { AstAnalysis } from "../../core/ast/types";
import type { HoundsmanEngine } from "../../core/engine/houndsman-engine";
import type { RunClassification } from "../../core/engine/review-scope";
import { parseEntries } from "../../core/file-classifier";
import type { LoggerLike } from "../../core/logging";
import type { PrepareResult } from "../../core/orchestrator";
import { defaultOptions, type ReviewOptions } from "../../core/orchestrator";
import type { ContextSummary } from "../../core/report-builder";
import type { AgentContext } from "../agent/agent-context";
import { AgentFactory } from "../agent/agent-factory";
import type { AgentReporter } from "../agent/agent-reporter";
import type { AgentResult } from "../agent/agent-result";
import { AgentRunner } from "../agent/agent-runner";
import { AgentScheduler } from "../agent/agent-scheduler";
import type { HarnessConfig } from "../config/harness-config";
import { BuiltinToolsModule } from "../tools/builtin";
import { ToolRegistry } from "../tools/tool-registry";
import { defaultFileReader } from "../validation/finding-validator";
import type { HuntOptions } from "./hunt-options";
import type { HuntResult } from "./hunt-result";
import { ReviewPlanner } from "./review-planner";

/** Dependências da sessão. */
export type HuntSessionDeps = {
	engine: HoundsmanEngine;
	options: HuntOptions;
	config: HarnessConfig;
	reporter: AgentReporter;
	logger: LoggerLike;
	provider?: ModelProvider;
	recorder: AiUsageRecorder;
};

/** Executa o hunt. */
export class HuntSession {
	constructor(private readonly deps: HuntSessionDeps) {}

	/** Roda prepare (seco ou não), agentes e finalize. */
	async run(): Promise<HuntResult> {
		const { engine, options, reporter } = this.deps;
		const messages: string[] = [];
		const reviewOptions: ReviewOptions = {
			...defaultOptions(),
			base: options.base,
			head: options.head,
			branch: options.branch,
			noJev: options.noJev,
			noAst: options.noAst,
			full: options.full,
			clean: options.clean,
			noAi: true,
			finalize: false,
			pr: options.pr,
			worktreePath: options.worktreePath,
		};

		const session = engine.session(reviewOptions);
		const prepared: PrepareResult = await this.deps.logger.withSpinner(
			"Preparando revisão...",
			() => session.prepare(),
		);
		messages.push(...prepared.messages);
		const review = session.context.review;
		const work = session.context.work;

		// Sem alterações desde a última revisão: não gasta IA nem reescreve nada.
		const artifact = engine.storage.readArtifact(review.id, "classification.json");
		if (
			!artifact ||
			prepared.messages.some((item) => item.startsWith("Nenhuma alteração"))
		) {
			return {
				status: "completed",
				reviewId: review.id,
				blockers: 0,
				attention: 0,
				watchdogs: [],
				usage: emptyUsage(),
				messages,
			};
		}

		const classification = this.readClassification(engine, review.id);
		const planned = await this.plan(classification, session.context.review, work);
		for (const item of planned) {
			item.context.outputPath = work.findingFile(item.context.watchdog.id);
		}

		if (options.dryRun) {
			messages.push(
				`Dry-run: ${planned.length} watchdog(s) sem chamadas de IA.`,
				...planned.map(
					(item) =>
						`- ${item.context.watchdog.id}: ${item.files.length} arquivo(s)` +
						(item.overflow.length > 0
							? `, ${item.overflow.length} fora do orçamento`
							: ""),
				),
			);
			return {
				status: "dry-run",
				reviewId: review.id,
				blockers: 0,
				attention: 0,
				watchdogs: [],
				usage: emptyUsage(),
				messages,
			};
		}

		if (!this.deps.provider) {
			throw new Error(
				"hunt exige IA configurada (HOUNDSMAN_DEEP_SEEK_API_KEY) ou provider injetado.",
			);
		}

		const registry = new ToolRegistry();
		registry.registerModule(new BuiltinToolsModule());
		const factory = new AgentFactory({
			provider: this.deps.provider,
			registry,
			reporter,
			config: this.deps.config,
			ast: engine.ast,
			readFile: defaultFileReader(engine.root),
		});
		const runner = new AgentRunner(factory);
		const scheduler = new AgentScheduler(
			runner,
			this.deps.config.concurrency,
			reporter,
		);

		// `--resume`: watchdogs com findings válidos no staging são preservados.
		const pending = options.resume
			? planned.filter(
					(item) =>
						!hasValidFindings(work.findingFile(item.context.watchdog.id)),
				)
			: planned;
		if (pending.length < planned.length) {
			messages.push(
				`Resume: ${planned.length - pending.length} watchdog(s) preservado(s) do staging.`,
			);
		}

		const contexts: AgentContext[] = pending.map((item) => item.context);
		const outcomes = await scheduler.run(contexts);
		const results: AgentResult[] = [];
		let partial = false;
		let failed = false;

		for (const [index, outcome] of outcomes.entries()) {
			const context = contexts[index];
			if (!context) continue;
			results.push(outcome);
			this.deps.recorder.record(
				"harness",
				this.deps.provider.modelId,
				outcome.usage,
			);
			if (outcome.status === "done" && outcome.report) {
				work.writeFinding(
					context.watchdog.id,
					`${JSON.stringify(outcome.report, null, 2)}\n`,
				);
				messages.push(
					`[${context.watchdog.id}] ${outcome.report.findings.length} achado(s) em ${context.files.length} arquivo(s).`,
				);
				continue;
			}
			const reason = outcome.error ?? outcome.reason ?? "falha desconhecida";
			if (options.allowPartial) {
				partial = true;
				const synthetic = {
					watchdogId: context.watchdog.id,
					reviewedFiles: [],
					skipped: [`falha: ${reason}`],
					findings: [],
				};
				work.writeFinding(
					context.watchdog.id,
					`${JSON.stringify(synthetic, null, 2)}\n`,
				);
				messages.push(`[${context.watchdog.id}] parcial: ${reason}`);
			} else {
				failed = true;
				messages.push(`[${context.watchdog.id}] falhou: ${reason}`);
			}
		}

		for (const item of planned) {
			if (pending.some((entry) => entry.context === item.context)) continue;
			results.push({
				watchdogId: item.context.watchdog.id,
				status: "skipped",
				reason: "resume",
				usage: emptyUsage(),
			});
		}

		this.writeTranscript(engine, review.id, classification, results);
		this.deps.recorder.write(engine.storage, review.id);

		const usage = totalUsage(results);
		if (failed) {
			return {
				status: "failed",
				reviewId: review.id,
				blockers: 0,
				attention: 0,
				watchdogs: results,
				usage,
				messages,
			};
		}

		const finalized = await this.deps.logger.withSpinner(
			"Consolidando relatório...",
			async () => engine.session({ ...reviewOptions, finalize: true }).finalize(),
		);
		messages.push(...finalized.messages);
		return {
			status: partial ? "partial" : "completed",
			reviewId: review.id,
			blockers: finalized.blockers,
			attention: finalized.attention,
			watchdogs: results,
			usage,
			messages,
		};
	}

	/** Lê a classificação persistida pelo prepare. */
	private readClassification(
		engine: HoundsmanEngine,
		reviewId: string,
	): RunClassification {
		const artifact = engine.storage.readArtifact(reviewId, "classification.json");
		if (!artifact) {
			throw new Error("hunt: classification.json ausente após o prepare.");
		}
		return JSON.parse(artifact.content) as RunClassification;
	}

	/** Monta os contextos + AST + impacto. */
	private async plan(
		classification: RunClassification,
		review: import("../../core/storage/types").ReviewRecord,
		work: import("../../core/storage/work-area").ReviewWorkArea,
	) {
		const { engine, options } = this.deps;
		const diff = engine.git.collectDiff(options.base, options.head);
		const entries = parseEntries(
			engine.git.diffNameStatus(options.base, options.head),
		);
		const baseRef = engine.git.mergeBase(options.base, options.head) ?? options.base;
		const ast: Map<string, AstAnalysis> = options.noAst
			? new Map()
			: await engine.ast.analyze(entries, diff, baseRef);
		const impact = ast.size > 0 ? await engine.ast.impact(ast) : undefined;
		const context =
			work.readContextSummary() ?? readContextSummary(engine, review.id);
		const planner = new ReviewPlanner({
			config: engine.config,
			project: engine.project,
			classification,
			context,
			ast,
			impact,
			repoRoot: engine.root,
			diff,
			branch: review.branch,
			watchdog: options.watchdog,
			maxCalls: this.deps.config.maxCalls,
		});
		return planner.plan();
	}

	/** Grava o transcript completo da investigação. */
	private writeTranscript(
		engine: HoundsmanEngine,
		reviewId: string,
		classification: RunClassification,
		results: AgentResult[],
	): void {
		const content = `${JSON.stringify(
			{
				provider: this.deps.config.provider,
				model: this.deps.config.model,
				classification: {
					mode: classification.mode,
					files: Object.keys(classification.files).length,
					watchdogs: Object.keys(classification.watchdogs),
				},
				watchdogs: results.map((result) => ({
					watchdogId: result.watchdogId,
					status: result.status,
					usage: result.usage,
					...(result.error ? { error: result.error } : {}),
					...(result.reason ? { reason: result.reason } : {}),
				})),
				journal: this.deps.reporter.journal.toJSON(),
			},
			null,
			2,
		)}\n`;
		engine.storage.writeArtifact(reviewId, {
			name: "harness-transcript.json",
			kind: "harness-transcript",
			content,
		});
	}
}

/** Findings válidos já gravados (resume). */
function hasValidFindings(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { findings?: unknown };
		return Array.isArray(parsed.findings);
	} catch {
		return false;
	}
}

/** Soma o uso de todos os agentes. */
function totalUsage(results: readonly AgentResult[]): AiUsage {
	return results.reduce((acc, result) => addUsage(acc, result.usage), emptyUsage());
}

/** Resumo do contexto persistido (quando o staging já foi limpo). */
function readContextSummary(
	engine: HoundsmanEngine,
	reviewId: string,
): ContextSummary | null {
	const artifact = engine.storage.readArtifact(reviewId, "context-summary.json");
	if (!artifact) return null;
	try {
		return JSON.parse(artifact.content) as ContextSummary;
	} catch {
		return null;
	}
}
