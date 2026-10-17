/**
 * Orçamento de chamadas de tool por agente.
 */

/** Erro de orçamento de tools. */
export class ToolBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolBudgetError";
	}
}

/** Orçamento de chamadas (total e por tool). */
export class ToolCallBudget {
	private readonly maxCalls: number;
	private readonly maxPerTool: number;
	private used = 0;
	private readonly perTool = new Map<string, number>();

	constructor(maxCalls = 30, maxPerTool = 12) {
		this.maxCalls = maxCalls;
		this.maxPerTool = maxPerTool;
	}

	get total(): number {
		return this.used;
	}

	get remaining(): number {
		return Math.max(0, this.maxCalls - this.used);
	}

	/** `true` quando ainda cabe a chamada. */
	canCall(name: string): boolean {
		if (this.used >= this.maxCalls) return false;
		return (this.perTool.get(name) ?? 0) < this.maxPerTool;
	}

	/** Consome uma chamada; lança quando o orçamento acabou. */
	consume(name: string): void {
		if (this.used >= this.maxCalls) {
			throw new ToolBudgetError(
				`Orçamento de ${this.maxCalls} chamada(s) de tool por agente esgotado.`,
			);
		}
		const calls = this.perTool.get(name) ?? 0;
		if (calls >= this.maxPerTool) {
			throw new ToolBudgetError(
				`Limite de ${this.maxPerTool} chamada(s) da tool '${name}' atingido.`,
			);
		}
		this.used++;
		this.perTool.set(name, calls + 1);
	}

	/** Contagem por tool (transcript). */
	snapshot(): Record<string, number> {
		return Object.fromEntries(this.perTool);
	}
}
