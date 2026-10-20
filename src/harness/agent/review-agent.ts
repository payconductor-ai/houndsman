/**
 * Máquina de estados do revisor (`ReviewAgent`).
 *
 * ORIENT → PLAN → INVESTIGATE → VERIFY → CONCLUDE. O modelo escolhe *como*
 * investigar dentro de INVESTIGATE; ele **não** pode pular VERIFY nem emitir
 * findings sem evidência.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AiProviderOptions,
	type AiUsage,
	addUsage,
	emptyUsage,
	type ModelProvider,
} from "../../core/ai";
import type { AstService } from "../../core/ast/service";
import type { WatchdogReport } from "../../core/report-builder";
import type { Severity } from "../../core/types";
import { AgentState } from "../investigation/agent-state";
import type { FindingDraft } from "../investigation/evidence";
import { EvidenceVerifier } from "../investigation/evidence-verifier";
import { downgrade, FindingCritic } from "../investigation/finding-critic";
import { InvestigationPlanner } from "../investigation/investigation-planner";
import {
	InvestigateOutputSchema,
	OrientOutputSchema,
	PlanOutputSchema,
} from "../prompts/agent-schemas";
import {
	buildReviewerSystem,
	buildReviewerUser,
} from "../prompts/reviewer-prompt-builder";
import { investigatePrompt } from "../prompts/states/investigate-prompt";
import { orientPrompt } from "../prompts/states/orient-prompt";
import { ToolCache } from "../tools/tool-cache";
import { ToolCallBudget } from "../tools/tool-call-budget";
import type { ToolContext } from "../tools/tool-context";
import { ToolMiddleware } from "../tools/tool-middleware";
import { type AgentStateName, ToolPolicy } from "../tools/tool-policy";
import type { ToolRegistry } from "../tools/tool-registry";
import { Toolbox } from "../tools/toolbox";
import { FindingValidator } from "../validation/finding-validator";
import type { AgentContext } from "./agent-context";
import type { AgentReporter } from "./agent-reporter";
import type { AgentResult } from "./agent-result";

/** Dependências do agente. */
export type ReviewAgentDeps = {
	context: AgentContext;
	provider: ModelProvider;
	registry: ToolRegistry;
	policy?: ToolPolicy;
	reporter: AgentReporter;
	maxOutputTokens: number;
	temperature: number;
	providerOptions?: AiProviderOptions;
	timeoutMs: number;
	ast: AstService;
	readFile?: (path: string) => string | null;
};

/** Resultado final de um agente com o estado (para transcript). */
export type ReviewAgentOutcome = AgentResult & { state: AgentState };

/** Agente de um watchdog. */
export class ReviewAgent {
	private readonly deps: ReviewAgentDeps;
	private readonly state = new AgentState();
	private usage: AiUsage = emptyUsage();
	private readonly toolbox: Toolbox;
	private readonly toolContext: ToolContext;

	constructor(deps: ReviewAgentDeps) {
		this.deps = deps;
		const toolBudget = new ToolCallBudget(
			deps.context.maxCalls,
			Math.max(4, Math.ceil(deps.context.maxCalls / 2)),
		);
		const middleware = new ToolMiddleware();
		const policy = deps.policy ?? new ToolPolicy();
		this.toolbox = new Toolbox(deps.registry, policy, middleware);
		this.toolContext = {
			repoRoot: deps.context.repoRoot,
			watchdog: deps.context.watchdog,
			diff: deps.context.diff,
			ast: deps.ast,
			state: this.state,
			budget: toolBudget,
			cache: new ToolCache(),
			logger: deps.reporter,
			agent: deps.context,
			rules: new Map(
				deps.context.rules.map((analysis) => [analysis.rule, analysis]),
			),
		};
	}

	/** Executa a investigação completa. */
	async run(): Promise<ReviewAgentOutcome> {
		const { context, reporter } = this.deps;
		const plan = new InvestigationPlanner().plan(
			{
				watchdogId: context.watchdog.id,
				files: context.files,
				symbols: symbolsOf(context),
				impacted: context.impact?.affectedFiles,
			},
			context.rules,
		);
		this.state.setTasks(plan.tasks);

		try {
			await this.orient();
			this.transition("ORIENT", "PLAN");
			await this.plan();
			this.transition("PLAN", "INVESTIGATE");
			await this.investigate();
			this.transition("INVESTIGATE", "VERIFY");
			const kept = this.verify();
			this.transition("VERIFY", "CONCLUDE");
			const report = this.conclude(kept);
			reporter.progress(
				`[${context.watchdog.id}] concluído (${report.findings.length} achado(s)).`,
			);
			return {
				watchdogId: context.watchdog.id,
				status: "done",
				report,
				usage: this.usage,
				state: this.state,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			reporter.journal.note(`falha: ${message}`);
			return {
				watchdogId: context.watchdog.id,
				status: "failed",
				error: message,
				usage: this.usage,
				state: this.state,
			};
		}
	}

	/** ORIENT — hipóteses iniciais (falha não derruba a investigação). */
	private async orient(): Promise<void> {
		try {
			const output = await this.callModel(
				"harness-orient",
				OrientOutputSchema,
				orientPrompt(this.deps.context),
				1,
			);
			for (const hypothesis of output.hypotheses)
				this.state.addHypothesis(hypothesis);
		} catch (error) {
			this.deps.reporter.journal.note(
				`orient falhou (segue): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** PLAN — seleciona tarefas do plano determinístico. */
	private async plan(): Promise<void> {
		const pending = this.state.tasksByStatus("pending");
		if (pending.length === 0) return;
		try {
			const output = await this.callModel(
				"harness-plan",
				PlanOutputSchema,
				[
					"Escolha as tarefas que serão investigadas (ids).",
					...pending.map((task) => `- ${task.id}: ${task.rule}`),
				].join("\n"),
				1,
			);
			const selected = new Set(output.taskIds);
			if (selected.size === 0) return;
			for (const task of pending) {
				if (!selected.has(task.id)) this.state.skipTask(task.id, "fora do plano");
			}
		} catch (error) {
			this.deps.reporter.journal.note(
				`plan falhou (segue com o plano determinístico): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/** INVESTIGATE — tools + evidências + drafts. */
	private async investigate(): Promise<void> {
		const { context } = this.deps;
		const tools = this.toolbox.toModelTools("INVESTIGATE", this.toolContext);
		const system = buildReviewerSystem(context, this.toolbox.describe("INVESTIGATE"));
		const prompt = [
			buildReviewerUser(context),
			"",
			this.state.hypotheses.length > 0
				? `## Hipóteses\n${this.state.hypotheses.map((item) => `- ${item}`).join("\n")}`
				: "",
			"",
			investigatePrompt(context, this.state.tasksByStatus("pending")),
		].join("\n");

		const output = await this.callModel(
			"harness-investigate",
			InvestigateOutputSchema,
			prompt,
			context.maxSteps,
			system,
			tools,
		);

		for (const draft of output.findingDrafts) this.state.addDraft(draft);
		for (const coverage of output.coverage) {
			this.state.setCoverage(coverage.rule, coverage.status, coverage.reason);
		}
		for (const task of this.state.tasksByStatus("pending")) {
			const covered = this.state.isCovered(task.rule);
			this.state.completeTask(
				task.id,
				covered ? "coberto" : "investigado sem cobertura",
			);
			if (!covered)
				this.state.setCoverage(task.rule, "skipped", "sem cobertura do modelo");
		}
	}

	/** VERIFY — evidência obrigatória + crítica. */
	private verify(): FindingDraft[] {
		const { context } = this.deps;
		const readFile = this.deps.readFile ?? this.defaultReader();
		const allowed = new Set([
			...context.files,
			...(context.impact?.affectedFiles ?? []),
		]);
		const verifier = new EvidenceVerifier({ allowedFiles: allowed, readFile });
		const critic = new FindingCritic({
			knownRules: new Set(context.watchdog.rules.map((rule) => rule.text.trim())),
			verifier,
			allowEmergentFindings:
				context.watchdog.definition.allowEmergentFindings === true,
		});
		const decisions = critic.review(this.state.drafts, this.state);
		const kept: FindingDraft[] = [];
		for (const decision of decisions) {
			this.deps.reporter.journal.note(
				`crítico: ${decision.verdict} ${decision.draft.file}:${decision.draft.line ?? "?"} — ${decision.reason}`,
			);
			if (decision.verdict === "drop") {
				this.state.setCoverage(
					decision.draft.rule,
					"checked",
					"refutado pelo crítico",
				);
				continue;
			}
			kept.push(
				decision.verdict === "downgrade"
					? {
							...decision.draft,
							severity: downgrade(decision.draft.severity),
							confidence: decision.draft.confidence,
						}
					: decision.draft,
			);
			this.state.setCoverage(decision.draft.rule, "checked", "confirmado");
		}
		return kept;
	}

	/** CONCLUDE — relatório determinístico + cobertura honesta. */
	private conclude(kept: readonly FindingDraft[]): WatchdogReport {
		const { context } = this.deps;
		for (const rule of context.watchdog.rules) {
			if (!this.state.isCovered(rule.text)) {
				this.state.setCoverage(rule.text, "skipped", "não investigada");
			}
		}
		const evidenceFiles = new Set(
			[...this.state.evidence.values()].map((item) => item.file),
		);
		const skipped = new Set(context.overflow.map((file) => `${file} (budget)`));
		for (const coverage of this.state.coverage.values()) {
			if (coverage.status === "skipped") {
				skipped.add(`${coverage.rule} — ${coverage.reason ?? "skipped"}`);
			}
		}

		const report: WatchdogReport = {
			watchdogId: context.watchdog.id,
			reviewedFiles: [...evidenceFiles].filter((file) =>
				context.files.includes(file),
			),
			skipped: [...skipped],
			findings: kept.map((draft) => ({
				rule: draft.rule,
				severity: draft.severity as Severity,
				file: draft.file,
				...(draft.line ? { line: draft.line } : {}),
				message: draft.message,
				action: draft.action,
				evidence: this.evidenceLabel(draft),
			})),
		};

		const validator = new FindingValidator({
			watchdogId: context.watchdog.id,
			knownRules: new Set(context.watchdog.rules.map((rule) => rule.text.trim())),
			allowedFiles: new Set([
				...context.files,
				...(context.impact?.affectedFiles ?? []),
			]),
			overflow: new Set(context.overflow),
			readFile: this.deps.readFile ?? this.defaultReader(),
			allowEmergentFindings:
				context.watchdog.definition.allowEmergentFindings === true,
		});
		const result = validator.validate(report);
		for (const dropped of result.dropped) {
			this.deps.reporter.journal.note(
				`validator: descartado ${dropped.finding} — ${dropped.reason}`,
			);
		}
		return result.report;
	}

	/** Chamada de modelo com uso e timeout. */
	private async callModel<T>(
		feature: string,
		schema: import("zod").ZodType<T>,
		prompt: string,
		maxSteps: number,
		instructions?: string,
		tools?: Record<string, import("../../core/ai").AiTool>,
	): Promise<T> {
		const response = await this.deps.provider.generate<T>({
			instructions,
			prompt,
			outputSchema: schema,
			...(tools ? { tools } : {}),
			maxSteps,
			maxOutputTokens: this.deps.maxOutputTokens,
			temperature: this.deps.temperature,
			...(this.deps.providerOptions
				? { providerOptions: this.deps.providerOptions }
				: {}),
			signal: AbortSignal.timeout(this.deps.timeoutMs),
		});
		this.usage = addUsage(this.usage, response.usage);
		this.deps.reporter.journal.note(
			`${feature}: ${response.usage.calls} chamada(s), ${response.usage.totalTokens} token(s)`,
		);
		return response.output;
	}

	/** Transição de estado registrada no journal. */
	private transition(from: AgentStateName, to: AgentStateName): void {
		this.deps.reporter.journal.transition(from, to);
	}

	/** Rótulo de evidência (`arquivo:linha`). */
	private evidenceLabel(draft: FindingDraft): string {
		const first = draft.evidenceIds
			.map((id) => this.state.getEvidence(id))
			.find((item) => item !== undefined);
		if (!first) return draft.file;
		return `${first.file}:${first.startLine}-${first.endLine}`;
	}

	/** Leitor padrão: relativo à raiz do repo. */
	private defaultReader(): (path: string) => string | null {
		const root = this.deps.context.repoRoot;
		return (path: string) => {
			try {
				return readFileSync(join(root, path), "utf8");
			} catch {
				return null;
			}
		};
	}
}

/** Símbolos citados nas regras (para o planner). */
function symbolsOf(context: AgentContext): string[] {
	const symbols = new Set<string>();
	for (const analysis of context.rules) {
		for (const signal of analysis.signals) {
			if (signal.kind === "symbol") symbols.add(signal.value);
		}
	}
	for (const analysis of context.ast.values()) {
		for (const symbol of analysis.delta?.addedSymbols ?? []) symbols.add(symbol.name);
		for (const symbol of analysis.delta?.modifiedSymbols ?? [])
			symbols.add(symbol.name);
	}
	return [...symbols].slice(0, 30);
}
