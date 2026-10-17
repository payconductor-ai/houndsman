/**
 * Limites de resultado das tools (linhas, bytes, resultados).
 *
 * Nenhuma tool devolve arquivo inteiro por default. Os limites são parte do
 * contrato: o agente recebe `truncated: true` e um `hint` para refinar.
 */

/** Limites canônicos das tools. */
export const TOOL_LIMITS = {
	maxLines: 200,
	maxBytes: 32 * 1024,
	maxResults: 50,
	maxFiles: 200,
	maxSnippetLines: 60,
} as const;

/** Resultado de um corte de linhas. */
export type LimitedLines = { lines: string[]; truncated: boolean };

/** Mantém no máximo `max` linhas. */
export function limitLines(
	lines: readonly string[],
	max: number = TOOL_LIMITS.maxLines,
): LimitedLines {
	if (lines.length <= max) return { lines: [...lines], truncated: false };
	return { lines: lines.slice(0, max), truncated: true };
}

/** Corta um texto em bytes (UTF-8) sem estourar o orçamento. */
export function limitText(
	text: string,
	maxBytes: number = TOOL_LIMITS.maxBytes,
): {
	text: string;
	truncated: boolean;
} {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && encoder.encode(text.slice(0, end)).length > maxBytes) end--;
	return { text: text.slice(0, Math.max(0, end)), truncated: true };
}

/** Numera as linhas a partir de `startLine` (1-based), como `cat -n`. */
export function numberLines(startLine: number, lines: readonly string[]): string {
	return lines
		.map((line, index) => `${String(startLine + index).padStart(4, " ")}\t${line}`)
		.join("\n");
}
