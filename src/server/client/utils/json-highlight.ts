/**
 * Destaque de sintaxe JSON (cliente) — implementação própria e leve.
 *
 * Não puxa lib de highlight: tokeniza o texto já formatado e devolve spans.
 * Funciona para qualquer JSON gerado pelo houndsman (manifest, classification,
 * context, candidates, …).
 */

export type JsonTokenType = "plain" | "key" | "string" | "number" | "literal" | "punct";

export type JsonToken = { text: string; type: JsonTokenType };

const TOKEN =
	/("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** Pretty-print best-effort; devolve o original se não for JSON válido. */
export function formatJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** Tokeniza o JSON preservando o texto original (inclusive espaços/quebras). */
export function highlightJson(text: string): JsonToken[] {
	const tokens: JsonToken[] = [];
	let last = 0;
	for (const match of text.matchAll(TOKEN)) {
		const index = match.index ?? 0;
		if (index > last) {
			tokens.push({ text: text.slice(last, index), type: "plain" });
		}
		if (match[1] !== undefined) {
			tokens.push({
				text: match[1],
				type: match[2] !== undefined ? "key" : "string",
			});
			if (match[2] !== undefined) {
				tokens.push({ text: match[2], type: "punct" });
			}
		} else if (match[3] !== undefined) {
			tokens.push({ text: match[3], type: "number" });
		} else if (match[4] !== undefined) {
			tokens.push({ text: match[4], type: "literal" });
		} else if (match[5] !== undefined) {
			tokens.push({ text: match[5], type: "punct" });
		}
		last = index + match[0].length;
	}
	if (last < text.length) {
		tokens.push({ text: text.slice(last), type: "plain" });
	}
	return tokens;
}
