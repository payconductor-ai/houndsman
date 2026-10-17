/**
 * Resultado padrão de uma tool (reexport de contrato).
 */

export type { ToolResult } from "./agent-tool";

/** Resultado de sucesso. */
export function ok<T>(data: T, extra: Record<string, unknown> = {}) {
	return { ok: true as const, data, ...extra };
}

/** Resultado de erro estruturado. */
export function fail(error: string) {
	return { ok: false as const, error };
}
