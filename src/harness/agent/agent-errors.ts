/**
 * Erros do harness nativo.
 */

/** Falha de configuração/execução do agente. */
export class AgentError extends Error {
	constructor(
		message: string,
		readonly watchdogId?: string,
	) {
		super(message);
		this.name = "AgentError";
	}
}

/** Orçamento de IA/tools esgotado durante a investigação. */
export class AgentBudgetError extends AgentError {
	constructor(message: string, watchdogId?: string) {
		super(message, watchdogId);
		this.name = "AgentBudgetError";
	}
}

/** Saída do modelo inválida após as tentativas permitidas. */
export class AgentOutputError extends AgentError {
	constructor(message: string, watchdogId?: string) {
		super(message, watchdogId);
		this.name = "AgentOutputError";
	}
}
