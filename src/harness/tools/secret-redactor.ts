/**
 * Redação de segredos em resultados de tools/logs.
 *
 * Cobre chaves do ambiente do houndsman, tokens comuns (`sk-...`, `Bearer`) e
 * pares `chave=valor` sensíveis. Nunca loga prompt nem conteúdo de `.env`.
 */

import { env } from "../../core/env";

/** Padrões genéricos de segredo. */
const PATTERNS: readonly [RegExp, string][] = [
	[/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [REDACTED]"],
	[
		/\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^\s"',}]+/gi,
		"$1: [REDACTED]",
	],
	[/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]"],
];

/** Substitui os valores reais do ambiente (sem revelá-los). */
function redactEnvValues(text: string): string {
	let result = text;
	for (const value of [env.deepSeekApiKey, env.typeSafeApiKey]) {
		if (!value || value.length < 6) continue;
		result = result.split(value).join("[REDACTED]");
	}
	return result;
}

/** Redige segredos de um texto. */
export function redactSecrets(text: string): string {
	let result = redactEnvValues(text);
	for (const [pattern, replacement] of PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

/** Redige recursivamente strings de um valor (preserva a forma). */
export function redactValue<T>(value: T): T {
	if (typeof value === "string") return redactSecrets(value) as unknown as T;
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item)) as unknown as T;
	}
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			output[key] = redactValue(item);
		}
		return output as unknown as T;
	}
	return value;
}
