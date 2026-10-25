/**
 * Markdown mínimo do `action` — blocos, inline e sanitização de links.
 */

import { describe, expect, test } from "bun:test";
import {
	isFilePath,
	parseInline,
	parseMarkdown,
	safeUrl,
	sectionBlocks,
} from "../server/client/utils/markdown";

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

	test("reconhece títulos, tabela e régua horizontal", () => {
		const blocks = parseMarkdown(
			"# Relatório\n\n| Arquivo | Severidade |\n|---|:---:|\n| a.ts | blocking |\n\n---",
		);
		expect(blocks).toEqual([
			{ type: "heading", level: 1, text: "Relatório" },
			{
				type: "table",
				align: [undefined, "center"],
				header: ["Arquivo", "Severidade"],
				rows: [["a.ts", "blocking"]],
			},
			{ type: "hr" },
		]);
	});

	test("colunas só de números e barra alinham à direita", () => {
		const blocks = parseMarkdown(
			"| Arquivo | Linhas | Razão |\n|---|---|---|\n| a.ts | 12 | 3/4 |\n| b.ts | 7 | 1/2 |",
		);
		expect(blocks[0]).toMatchObject({
			type: "table",
			align: [undefined, "right", "right"],
		});
	});

	test("extrai os blocos de uma seção específica", () => {
		const blocks = sectionBlocks(
			"# Título\n\n## Resumo de negócio\n\nTexto A.\n\n## Pontos técnicos\n\nTexto B.",
			"resumo de negócio",
		);
		expect(blocks).toEqual([{ type: "paragraph", text: "Texto A." }]);
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

	test("destaca caminhos de arquivo no texto corrido", () => {
		expect(parseInline("veja src/foo/bar.ts e manifest.json")).toEqual([
			{ type: "text", text: "veja " },
			{ type: "path", text: "src/foo/bar.ts" },
			{ type: "text", text: " e " },
			{ type: "path", text: "manifest.json" },
		]);
	});
});

describe("isFilePath", () => {
	test("reconhece arquivos e caminhos, sem confundir texto comum", () => {
		expect(isFilePath("src/foo/bar.ts")).toBe(true);
		expect(isFilePath("manifest.json")).toBe(true);
		expect(isFilePath("./scripts/ci.sh")).toBe(true);
		expect(isFilePath("M/D")).toBe(false);
		expect(isFilePath("duas palavras.ts")).toBe(false);
		expect(isFilePath("https://x.dev/file.ts")).toBe(false);
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
