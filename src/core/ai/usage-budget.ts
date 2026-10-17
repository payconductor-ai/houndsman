/**
 * Orçamento de IA por review (chamadas e tokens).
 *
 * O budget é consultado antes de cada chamada e atualizado com o uso real. Ao
 * estourar, o chamador decide parar (features do core) ou falhar (harness).
 */

import { AiBudgetError } from "./errors";
import { type AiUsage, addUsage, emptyUsage } from "./types";

/** Tetos do budget (ausente = sem teto). */
export type AiBudgetLimits = {
	maxCalls?: number;
	maxTokens?: number;
};

/** Orçamento de uso acumulado. */
export class AiUsageBudget {
	private readonly limits: AiBudgetLimits;
	private readonly total: AiUsage = emptyUsage();

	constructor(limits: AiBudgetLimits = {}) {
		this.limits = limits;
	}

	get usage(): AiUsage {
		return { ...this.total };
	}

	get maxCalls(): number | undefined {
		return this.limits.maxCalls;
	}

	/** `true` quando ainda há orçamento para outra chamada. */
	get canCall(): boolean {
		if (
			this.limits.maxCalls !== undefined &&
			this.total.calls >= this.limits.maxCalls
		) {
			return false;
		}
		if (
			this.limits.maxTokens !== undefined &&
			this.total.totalTokens >= this.limits.maxTokens
		) {
			return false;
		}
		return true;
	}

	/** Lança quando o orçamento acabou. */
	assertCanCall(): void {
		if (!this.canCall) throw new AiBudgetError(this.describeExhaustion());
	}

	/** Registra o uso de uma chamada concluída. */
	record(usage: AiUsage): void {
		const merged = addUsage(this.total, usage);
		this.total.inputTokens = merged.inputTokens;
		this.total.outputTokens = merged.outputTokens;
		this.total.totalTokens = merged.totalTokens;
		this.total.calls = merged.calls;
	}

	/** Motivo legível do esgotamento. */
	private describeExhaustion(): string {
		if (
			this.limits.maxCalls !== undefined &&
			this.total.calls >= this.limits.maxCalls
		) {
			return `Teto de ${this.limits.maxCalls} chamada(s) de IA por review atingido.`;
		}
		return `Teto de ${this.limits.maxTokens ?? 0} token(s) de IA por review atingido.`;
	}
}
