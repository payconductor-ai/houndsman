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

/** Teto do detalhe persistido (uma linha do `ai-usage.json`). */
const DETAIL_LIMIT = 600;

/** Campos diagnósticos que o AI SDK anexa ao erro (varia por versão). */
type DiagnosticSource = {
	message?: unknown;
	text?: unknown;
	issues?: unknown;
	cause?: unknown;
};

/** Achata espaços/quebras para caber em uma linha do artefato. */
function flatten(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Issues do Zod no formato `campo: mensagem`. */
function formatIssues(raw: unknown): string {
	if (!Array.isArray(raw)) return "";
	const parts: string[] = [];
	for (const item of raw.slice(0, 8)) {
		const issue = (item ?? {}) as { path?: unknown; message?: unknown };
		const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
		const message = typeof issue.message === "string" ? issue.message : "";
		if (path === "" && message === "") continue;
		parts.push(path === "" ? message : `${path}: ${message}`);
	}
	return parts.join("; ");
}

/**
 * Detalhe seguro de uma falha de IA: causa encadeada, issues do schema e
 * trecho da resposta bruta — nunca prompt nem chave.
 *
 * A mensagem raiz fica de fora: ela já é persistida em `error`, e repetir
 * polui o resumo do CLI. Sem nada além dela, devolve `undefined`.
 */
export function errorDetail(error: unknown, limit = DETAIL_LIMIT): string | undefined {
	const root = flatten(errorMessage(error));
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
		if (typeof current === "string") {
			const text = flatten(current);
			if (text !== "" && text !== root) parts.push(text);
			break;
		}
		if (seen.has(current)) break;
		seen.add(current);
		const source = current as DiagnosticSource;
		if (typeof source.message === "string") {
			const message = flatten(source.message);
			if (message !== "" && message !== root) parts.push(message);
		}
		if (typeof source.text === "string") {
			const text = flatten(source.text);
			if (text !== "") parts.push(`resposta: ${text}`);
		}
		const issues = formatIssues(source.issues);
		if (issues !== "") parts.push(`issues: ${issues}`);
		current = source.cause;
	}
	const unique = [...new Set(parts.filter((part) => part !== ""))];
	if (unique.length === 0) return undefined;
	const detail = unique.join(" | ");
	return detail.length > limit ? `${detail.slice(0, limit)}…` : detail;
}
