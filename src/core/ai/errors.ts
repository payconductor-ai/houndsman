/**
 * Erros da camada de IA — mensagens claras e sem segredos.
 */

/** Configuração ausente/inválida (provider, modelo ou chave). */
export class AiConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiConfigurationError";
	}
}

/** Teto de chamadas/tokens por review estourado. */
export class AiBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiBudgetError";
	}
}

/** Falha do provider (rede, timeout, resposta inválida). */
export class AiProviderError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "AiProviderError";
	}
}

/** Mensagem segura de um erro desconhecido. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
