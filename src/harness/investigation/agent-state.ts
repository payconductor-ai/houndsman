/**
 * Estado de um agente de investigação.
 *
 * Acumula tarefas, hipóteses, evidências, cobertura de regras, drafts e custo.
 * É a única fonte de verdade que o verificador/crítico consultam.
 */

import {
	type Evidence,
	type EvidenceKind,
	evidenceId,
	type FindingDraft,
	type RuleCoverage,
	type RuleCoverageStatus,
} from "./evidence";
import type { InvestigationTask } from "./investigation-task";

/** Entrada para registrar uma evidência. */
export type EvidenceInput = Omit<Evidence, "id"> & { id?: string };

/** Estado mutável de um agente. */
export class AgentState {
	readonly tasks: InvestigationTask[] = [];
	readonly hypotheses: string[] = [];
	readonly evidence = new Map<string, Evidence>();
	readonly coverage = new Map<string, RuleCoverage>();
	readonly drafts: FindingDraft[] = [];
	readonly toolCalls = new Map<string, number>();
	private sequence = 0;

	/** Registra as tarefas do plano. */
	setTasks(tasks: InvestigationTask[]): void {
		this.tasks.push(...tasks);
	}

	/** Tarefas por status. */
	tasksByStatus(status: InvestigationTask["status"]): InvestigationTask[] {
		return this.tasks.filter((task) => task.status === status);
	}

	/** Marca uma tarefa como concluída. */
	completeTask(id: string, reason?: string): void {
		const task = this.tasks.find((item) => item.id === id);
		if (!task) return;
		task.status = "done";
		if (reason) task.reason = reason;
	}

	/** Marca uma tarefa como pulada (com motivo). */
	skipTask(id: string, reason: string): void {
		const task = this.tasks.find((item) => item.id === id);
		if (!task) return;
		task.status = "skipped";
		task.reason = reason;
	}

	/** Adiciona uma hipótese (sem duplicar). */
	addHypothesis(hypothesis: string): void {
		const value = hypothesis.trim();
		if (value && !this.hypotheses.includes(value)) this.hypotheses.push(value);
	}

	/** Registra evidência e devolve o id gerado. */
	addEvidence(input: EvidenceInput): Evidence {
		const id = input.id?.trim() ? input.id.trim() : evidenceId(++this.sequence);
		const evidence: Evidence = { ...input, id };
		this.evidence.set(id, evidence);
		return evidence;
	}

	/** Evidência por id (undefined se não existe). */
	getEvidence(id: string): Evidence | undefined {
		return this.evidence.get(id);
	}

	/** Evidências de uma tool/esécie. */
	evidenceOfKind(kind: EvidenceKind): Evidence[] {
		return [...this.evidence.values()].filter((item) => item.kind === kind);
	}

	/** Adiciona um draft de finding. */
	addDraft(draft: FindingDraft): void {
		this.drafts.push(draft);
	}

	/** Define a cobertura de uma regra (idempotente por texto). */
	setCoverage(rule: string, status: RuleCoverageStatus, reason?: string): void {
		const existing = this.coverage.get(rule);
		if (existing) {
			existing.status = status;
			if (reason) existing.reason = reason;
			return;
		}
		this.coverage.set(rule, {
			rule,
			status,
			files: [],
			symbols: [],
			...(reason ? { reason } : {}),
		});
	}

	/** Cobertura atual de uma regra. */
	coverageOf(rule: string): RuleCoverage | undefined {
		return this.coverage.get(rule);
	}

	/** `true` quando a regra já foi coberta de alguma forma. */
	isCovered(rule: string): boolean {
		return this.coverage.has(rule);
	}

	/** Registra o uso de uma tool (contagem por nome). */
	recordToolCall(name: string): void {
		this.toolCalls.set(name, (this.toolCalls.get(name) ?? 0) + 1);
	}

	/** Chamadas registradas de uma tool. */
	callsOf(name: string): number {
		return this.toolCalls.get(name) ?? 0;
	}

	/** Snapshot serializável (sem prompts). */
	toJSON(): Record<string, unknown> {
		return {
			hypotheses: this.hypotheses,
			tasks: this.tasks,
			evidence: [...this.evidence.values()],
			coverage: [...this.coverage.values()],
			drafts: this.drafts,
			toolCalls: Object.fromEntries(this.toolCalls),
		};
	}
}
