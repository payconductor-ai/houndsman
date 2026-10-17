/**
 * Markdown mínimo do campo `action` (cliente).
 *
 * Suporta o suficiente para instruções curtas: parágrafos, quebras de linha,
 * listas, blockquote, blocos de código e formatação inline (`code`, **bold**,
 * *itálico*, links). Sem lib externa e sem HTML cru.
 */

export type MarkdownBlock =
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "code"; language: string | null; code: string }
	| { type: "quote"; text: string };

export type InlineToken =
	| { type: "text"; text: string }
	| { type: "code"; text: string }
	| { type: "strong"; text: string }
	| { type: "em"; text: string }
	| { type: "link"; text: string; url: string };

const FENCE = /^\s*```(\S*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+\.\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function isBlockStart(line: string): boolean {
	return (
		FENCE.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line)
	);
}

/** Divide o texto em blocos simples (sem aninhamento profundo). */
export function parseMarkdown(text: string): MarkdownBlock[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: MarkdownBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (line.trim().length === 0) {
			index++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const language = fence[1] || null;
			const code: string[] = [];
			index++;
			while (index < lines.length && !FENCE.test(lines[index])) {
				code.push(lines[index]);
				index++;
			}
			if (index < lines.length) index++;
			blocks.push({ type: "code", language, code: code.join("\n") });
			continue;
		}

		if (BULLET.test(line)) {
			const items: string[] = [];
			while (index < lines.length) {
				const item = BULLET.exec(lines[index]);
				if (!item) break;
				items.push(item[1]);
				index++;
			}
			blocks.push({ type: "list", ordered: false, items });
			continue;
		}

		if (ORDERED.test(line)) {
			const items: string[] = [];
			while (index < lines.length) {
				const item = ORDERED.exec(lines[index]);
				if (!item) break;
				items.push(item[1]);
				index++;
			}
			blocks.push({ type: "list", ordered: true, items });
			continue;
		}

		if (QUOTE.test(line)) {
			const quote: string[] = [];
			while (index < lines.length) {
				const item = QUOTE.exec(lines[index]);
				if (!item) break;
				quote.push(item[1]);
				index++;
			}
			blocks.push({ type: "quote", text: quote.join("\n") });
			continue;
		}

		const paragraph: string[] = [line];
		index++;
		while (
			index < lines.length &&
			lines[index].trim().length > 0 &&
			!isBlockStart(lines[index])
		) {
			paragraph.push(lines[index]);
			index++;
		}
		blocks.push({ type: "paragraph", text: paragraph.join("\n") });
	}

	return blocks;
}

/** Tokeniza formatação inline preservando o texto e a ordem dos marcadores. */
export function parseInline(text: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	// Ordem importa: code/bold antes de itálico; `_` exige fronteira de palavra.
	const pattern =
		/`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w])|\[[^\]\n]+\]\([^)\s]+\)/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		if (start > last) {
			tokens.push({ type: "text", text: text.slice(last, start) });
		}
		const raw = match[0];
		if (raw.startsWith("`")) {
			tokens.push({ type: "code", text: raw.slice(1, -1) });
		} else if (raw.startsWith("**") || raw.startsWith("__")) {
			tokens.push({ type: "strong", text: raw.slice(2, -2) });
		} else if (raw.startsWith("*") || raw.startsWith("_")) {
			tokens.push({ type: "em", text: raw.slice(1, -1) });
		} else {
			const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
			if (link) {
				tokens.push({ type: "link", text: link[1], url: link[2] });
			} else {
				tokens.push({ type: "text", text: raw });
			}
		}
		last = start + raw.length;
	}
	if (last < text.length) {
		tokens.push({ type: "text", text: text.slice(last) });
	}
	return tokens;
}

/** URL segura para links de markdown (evita `javascript:` e afins). */
export function safeUrl(url: string): string | null {
	const value = url.trim();
	if (/^(https?:|mailto:)/i.test(value)) return value;
	if (value.startsWith("/") && !value.startsWith("//")) return value;
	return null;
}
