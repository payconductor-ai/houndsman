/**
 * Planejador determinístico da investigação.
 *
 * Converte `RuleAnalysis[]` em tarefas priorizadas (severidade + confiança +
 * impacto). Uma estratégia diferente pode ser injetada sem tocar no agente.
 */

import { severityRank } from "../../core/types";
import type { ToolCapability } from "../tools/agent-tool";
import type {
	InvestigationPlan,
	InvestigationStrategy,
	InvestigationTask,
} from "./investigation-task";
import type { RuleAnalysis } from "./rule-analyzer";

/** Contexto mínimo do planejamento. */
export type PlannerContext = {
	watchdogId: string;
	files: readonly string[];
	symbols: readonly string[];
	/** Arquivos impactados (reverse deps) do diff. */
	impacted?: readonly string[];
};

/** Planejador default. */
export class InvestigationPlanner implements InvestigationStrategy {
	plan(context: PlannerContext, rules: readonly RuleAnalysis[]): InvestigationPlan {
		const tasks: InvestigationTask[] = [];
		const allFiles = [...new Set([...context.files, ...(context.impacted ?? [])])];
		let estimatedToolCalls = 0;

		rules.forEach((analysis, index) => {
			const symbols = analysis.signals
				.filter((signal) => signal.kind === "symbol")
				.map((signal) => signal.value);
			const matchedFiles = filesFor(analysis, context.files);
			const files = matchedFiles.length > 0 ? matchedFiles : [...context.files];
			const capabilities = capabilitiesFor(analysis);
			estimatedToolCalls +=
				analysis.checks.length + (capabilities.length > 0 ? 1 : 0);
			tasks.push({
				id: `rule-${index}`,
				rule: analysis.rule,
				severity: analysis.severity,
				kind: "rule-evidence",
				files,
				symbols: [...new Set([...symbols, ...context.symbols])].slice(0, 10),
				capabilities,
				priority: priorityOf(analysis, index),
				status: "pending",
			});
		});

		if (context.impacted && context.impacted.length > 0) {
			tasks.push({
				id: "impact",
				rule: "impacto das alterações",
				severity: "attention",
				kind: "symbol-impact",
				files: [...context.impacted],
				symbols: [...context.symbols],
				capabilities: ["impact", "references"],
				priority: 5,
				status: "pending",
			});
			estimatedToolCalls += 1;
		}

		tasks.sort((a, b) => a.priority - b.priority);
		return { tasks, totalFiles: allFiles.length, estimatedToolCalls };
	}
}

/** Arquivos da tarefa filtrados por `hints.paths` (regex) quando presentes. */
function filesFor(analysis: RuleAnalysis, files: readonly string[]): string[] {
	const patterns = analysis.signals
		.filter((signal) => signal.kind === "path")
		.map((signal) => signal.value);
	if (patterns.length === 0) return [...files];
	const matchers = patterns.flatMap((pattern) => {
		try {
			const regex = new RegExp(pattern);
			return [(file: string) => regex.test(file)];
		} catch {
			return [(file: string) => file.includes(pattern)];
		}
	});
	return files.filter((file) => matchers.some((match) => match(file)));
}

/** Capabilities sugeridas pela categoria/sinais da regra. */
function capabilitiesFor(analysis: RuleAnalysis): ToolCapability[] {
	const capabilities = new Set<ToolCapability>(["read", "search"]);
	const kinds = new Set(analysis.signals.map((signal) => signal.kind));
	if (kinds.has("symbol")) {
		capabilities.add("symbol");
		capabilities.add("references");
	}
	if (kinds.has("import") || kinds.has("path")) capabilities.add("search");
	if (analysis.category === "architecture" || analysis.category === "data") {
		capabilities.add("impact");
	}
	if (analysis.category === "tests") capabilities.add("tests");
	if (analysis.category === "security") capabilities.add("references");
	for (const check of analysis.checks) {
		if (check.tool === "symbol_context") capabilities.add("symbol");
		if (check.tool === "find_references") capabilities.add("references");
	}
	return [...capabilities];
}

/** Prioridade (menor = investigar antes). */
function priorityOf(analysis: RuleAnalysis, index: number): number {
	const confidencePenalty =
		analysis.confidence === "high" ? 0 : analysis.confidence === "medium" ? 2 : 4;
	return severityRank(analysis.severity) * 10 + confidencePenalty + index * 0.01;
}
