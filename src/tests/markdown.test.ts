/**
 * Markdown mínimo do `action` — blocos, inline e sanitização de links.
 */

import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown, safeUrl } from "../server/client/markdown";

describe("parseMarkdown", () => {
	test("separa parágrafos, listas, quote e bloco de código", () => {
		const blocks = parseMarkdown(
			"Primeira linha\nsegunda linha.\n\n- um\n- dois\n\n1. passo\n2. outro\n\n> nota\n\n```ts\nconst x = 1;\n```",
		);
		expect(blocks.map((block) => block.type)).toEqual([
			"paragraph",
			"list",
			"list",
			"quote",
			"code",
		]);
		expect(blocks[0]).toEqual({
			type: "paragraph",
			text: "Primeira linha\nsegunda linha.",
		});
		expect(blocks[1]).toEqual({
			type: "list",
			ordered: false,
			items: ["um", "dois"],
		});
		expect(blocks[2]).toEqual({
			type: "list",
			ordered: true,
			items: ["passo", "outro"],
		});
		expect(blocks[3]).toEqual({ type: "quote", text: "nota" });
		expect(blocks[4]).toEqual({
			type: "code",
			language: "ts",
			code: "const x = 1;",
		});
	});

	test("texto vazio não gera blocos", () => {
		expect(parseMarkdown("  \n\n ")).toEqual([]);
	});
});

describe("parseInline", () => {
	test("reconhece code, bold, itálico e link na ordem", () => {
		const tokens = parseInline(
			"Use `npm run ci` e **sempre** valide _tudo_ em [docs](https://x.dev).",
		);
		expect(tokens).toEqual([
			{ type: "text", text: "Use " },
			{ type: "code", text: "npm run ci" },
			{ type: "text", text: " e " },
			{ type: "strong", text: "sempre" },
			{ type: "text", text: " valide " },
			{ type: "em", text: "tudo" },
			{ type: "text", text: " em " },
			{ type: "link", text: "docs", url: "https://x.dev" },
			{ type: "text", text: "." },
		]);
	});

	test("não confunde underscore de identificador com itálico", () => {
		expect(parseInline("foo_bar_baz")).toEqual([
			{ type: "text", text: "foo_bar_baz" },
		]);
	});

	test("asterisco simples também vira itálico", () => {
		expect(parseInline("seja *rápido*")).toEqual([
			{ type: "text", text: "seja " },
			{ type: "em", text: "rápido" },
		]);
	});
});

describe("safeUrl", () => {
	test("aceita http(s)/mailto e caminho relativo; barra o resto", () => {
		expect(safeUrl("https://x.dev")).toBe("https://x.dev");
		expect(safeUrl("http://x.dev")).toBe("http://x.dev");
		expect(safeUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
		expect(safeUrl("/docs")).toBe("/docs");
		expect(safeUrl("javascript:alert(1)")).toBeNull();
		expect(safeUrl("//evil.dev")).toBeNull();
		expect(safeUrl("data:text/html,x")).toBeNull();
	});
});
