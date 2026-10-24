/**
 * Planejador da review nativa — monta um `AgentContext` por watchdog ativo.
 *
 * Lê a classificação já preparada (prepare) e aplica o orçamento por brief.
 * Nada aqui chama IA.
 */

import type { AstAnalysis, AstImpact } from "../../core/ast/types";
import type { ChangedScope } from "../../core/changed-scope";
import type { HoundsmanConfig } from "../../core/config";
import type { DiffSource } from "../../core/diff-source";
import { discoverDocs } from "../../core/doc-discoverer";
import { selectByBudget } from "../../core/domain/budget";
import type { RunClassification } from "../../core/engine/review-scope";
import type { ProjectConfig } from "../../core/project-config";
import type { ContextSummary } from "../../core/report-builder";
import type { ChurnMap } from "../../core/types";
import type { AgentContext } from "../agent/agent-context";
import { RuleAnalyzer } from "../investigation/rule-analyzer";

/** Entrada do planejador. */
export type ReviewPlannerInput = {
	config: HoundsmanConfig;
	project: ProjectConfig;
	classification: RunClassification;
	context: ContextSummary | null;
	ast: ReadonlyMap<string, AstAnalysis>;
	impact?: AstImpact;
	repoRoot: string;
	diff: DiffSource;
	/** Escopo do diff por arquivo (símbolos alterados; hunks como fallback). */
	changedScope?: ChangedScope;
	/** Branch alvo da review (prompt do agente). */
	branch: string;
	/** Filtra um único watchdog (`--watchdog`). */
	watchdog?: string;
	maxCalls: number;
};

/** Um watchdog planejado. */
export type PlannedWatchdog = {
	context: AgentContext;
	files: string[];
	overflow: string[];
};

/** Planeja os agentes da review. */
export class ReviewPlanner {
	private readonly input: ReviewPlannerInput;

	constructor(input: ReviewPlannerInput) {
		this.input = input;
	}

	/** Watchdogs ativos (filtrados) com contexto pronto. */
	plan(): PlannedWatchdog[] {
		const { config, project, classification, watchdog } = this.input;
		const ids = Object.keys(classification.watchdogs).filter(
			(id) => !watchdog || id === watchdog,
		);
		const docs = discoverDocs(Object.keys(classification.files), config);
		const maxFiles = project.maxFilesPerBrief;
		const analyzer = new RuleAnalyzer();
		const planned: PlannedWatchdog[] = [];

		for (const id of ids) {
			const domain = project.watchdogs.find(id);
			if (!domain) continue;
			const churn: ChurnMap = classification.churn;
			const { selected, overflow } = selectByBudget(
				classification.watchdogs[id] ?? [],
				churn,
				maxFiles,
			);
			const rules = analyzer.analyze(domain.rules);
			planned.push({
				files: selected,
				overflow,
				context: {
					watchdog: domain,
					projectName: project.projectName,
					branch: this.input.branch,
					files: selected,
					overflow,
					deleted: classification.deleted,
					docs,
					context: this.input.context,
					ast: this.input.ast,
					impact: this.input.impact,
					outputPath: "",
					maxSteps: project.aiMaxStepsFor(id),
					maxCalls: this.input.maxCalls,
					repoRoot: this.input.repoRoot,
					diff: this.input.diff,
					changedScope: this.input.changedScope ?? {},
					rules,
				},
			});
		}
		return planned;
	}
}
