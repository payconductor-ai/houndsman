/**
 * Markdown mínimo do cliente (campo `action` do finding e artefatos).
 *
 * Suporta o suficiente para instruções curtas e relatórios: parágrafos,
 * quebras de linha, listas, blockquote, títulos, tabelas, blocos de código e
 * formatação inline (`code`, **bold**, *itálico*, links). Sem lib externa e
 * sem HTML cru.
 */

/** Alinhamento de coluna em tabela markdown. */
export type MarkdownAlign = "left" | "center" | "right";

export type MarkdownBlock =
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "code"; language: string | null; code: string }
	| { type: "quote"; text: string }
	| { type: "heading"; level: number; text: string }
	| {
			type: "table";
			align: (MarkdownAlign | undefined)[];
			header: string[];
			rows: string[][];
	  }
	| { type: "hr" };

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
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isBlockStart(line: string): boolean {
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		BULLET.test(line) ||
		ORDERED.test(line) ||
		QUOTE.test(line)
	);
}

/** Quebra uma linha de tabela em células (remove os pipes das pontas). */
function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

/** `true` quando há um cabeçalho seguido da linha separadora de tabela. */
function isTableStart(lines: string[], index: number): boolean {
	if (index + 1 >= lines.length) return false;
	if (!lines[index].includes("|")) return false;
	return TABLE_SEP.test(lines[index + 1]);
}

/** Alinhamentos declarados na linha separadora (`:---`, `:---:`, `---:`). */
function parseAlignments(line: string): (MarkdownAlign | undefined)[] {
	return splitTableRow(line).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		if (left) return "left";
		return undefined;
	});
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

		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1].length,
				text: heading[2].trim(),
			});
			index++;
			continue;
		}

		if (HR.test(line)) {
			blocks.push({ type: "hr" });
			index++;
			continue;
		}

		if (isTableStart(lines, index)) {
			const header = splitTableRow(line);
			const align = parseAlignments(lines[index + 1]);
			const rows: string[][] = [];
			index += 2;
			while (
				index < lines.length &&
				lines[index].trim().length > 0 &&
				lines[index].includes("|")
			) {
				rows.push(splitTableRow(lines[index]));
				index++;
			}
			blocks.push({ type: "table", align, header, rows });
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
			!isBlockStart(lines[index]) &&
			!isTableStart(lines, index)
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
