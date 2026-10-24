/**
 * Escopo do diff — âncoras, símbolos alterados e fallback nos hunks.
 *
 * Congela a regra que impede o watchdog de reportar código pré-existente: só as
 * faixas tocadas pela revisão (símbolo folha do AST ou hunk) são revisáveis.
 */

import { describe, expect, test } from "bun:test";
import { changedAnchors } from "../core/ast/diff";
import type { AstAnalysis, AstFacts, AstSymbol } from "../core/ast/types";
import {
	buildChangedScope,
	formatRanges,
	formatSymbols,
	isLineInScope,
	mergeRanges,
	summarizeScope,
} from "../core/changed-scope";
import type { DiffSource } from "../core/diff-source";

/** Cabecalho padrão de um patch de arquivo. */
function patch(body: string): string {
	return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${body}`;
}

function diffOf(patchText: string): DiffSource {
	return {
		byFile: new Map([["src/a.ts", patchText]]),
		churn: new Map(),
	};
}

function symbol(
	overrides: Partial<AstSymbol> & Pick<AstSymbol, "name" | "kind">,
): AstSymbol {
	return {
		exported: false,
		startLine: 1,
		endLine: 1,
		...overrides,
	};
}

function analysis(facts: AstFacts): AstAnalysis {
	return { facts };
}

const FACTS: AstFacts = {
	language: "typescript",
	imports: [],
	exports: [],
	decorators: [],
	hasSyntaxErrors: false,
	symbols: [
		symbol({ name: "Outer", kind: "class", startLine: 1, endLine: 20 }),
		symbol({ name: "Outer.inner", kind: "method", startLine: 5, endLine: 10 }),
		symbol({ name: "top", kind: "function", startLine: 25, endLine: 30 }),
	],
};

describe("changedAnchors", () => {
	test("adições e remoções apontam para o lado novo", () => {
		const anchors = changedAnchors(
			patch(
				"@@ -10,3 +10,4 @@\n const before = 1;\n-const old = 2;\n+const current = 2;\n+const extra = 3;\n const after = 4;\n",
			),
		);

		expect([...anchors.added].sort((a, b) => a - b)).toEqual([11, 12]);
		expect([...anchors.deletedAt]).toEqual([11]);
	});

	test("remoção pura ancora no ponto do arquivo (sem consumir linha nova)", () => {
		const anchors = changedAnchors(patch("@@ -10,2 +10,0 @@\n-a\n-b\n"));

		expect([...anchors.added]).toEqual([]);
		expect([...anchors.deletedAt]).toEqual([10]);
	});
});

describe("buildChangedScope", () => {
	const entries = [{ path: "src/a.ts", status: "modified" }];

	test("âncora dentro de símbolo folha vira o intervalo do símbolo", () => {
		const text = patch(
			[
				"@@ -2,0 +3,1 @@",
				"+export const header = 1;",
				"@@ -7,0 +8,1 @@",
				"+  const inside = 1;",
				"@@ -26,0 +27,1 @@",
				"+  return 1;",
				"",
			].join("\n"),
		);
		const scope = buildChangedScope({
			entries,
			diff: diffOf(text),
			ast: new Map([["src/a.ts", analysis(FACTS)]]),
		});

		const file = scope["src/a.ts"];
		expect(file?.source).toBe("ast");
		// `inner` (5-10) e `top` (25-30); o container `Outer` não expande.
		expect(file?.symbols.map((item) => item.name)).toEqual(["Outer.inner", "top"]);
		// Cabeçalho da classe (linha 3) fica como faixa avulsa.
		expect(file?.ranges).toEqual([
			{ start: 3, end: 3 },
			{ start: 5, end: 10 },
			{ start: 25, end: 30 },
		]);
	});

	test("sem AST cai para os hunks do diff", () => {
		const text = patch("@@ -10,0 +11,2 @@\n+a\n+b\n");
		const scope = buildChangedScope({ entries, diff: diffOf(text) });

		const file = scope["src/a.ts"];
		expect(file?.source).toBe("hunks");
		expect(file?.symbols).toEqual([]);
		expect(file?.ranges).toEqual([{ start: 11, end: 12 }]);
	});

	test("rename/binário sem hunks fica sem faixas", () => {
		const scope = buildChangedScope({
			entries: [{ path: "src/a.ts", status: "renamed" }],
			diff: diffOf(patch("")),
		});

		expect(scope["src/a.ts"]).toEqual({ ranges: [], symbols: [], source: "hunks" });
	});

	test("arquivo deletado nem entra no escopo", () => {
		const scope = buildChangedScope({
			entries: [{ path: "src/a.ts", status: "deleted" }],
			diff: diffOf(patch("@@ -1,1 +0,0 @@\n-x\n")),
		});

		expect(scope["src/a.ts"]).toBeUndefined();
	});
});

describe("helpers de escopo", () => {
	test("isLineInScope respeita as faixas", () => {
		const scope = {
			"src/a.ts": {
				ranges: [{ start: 5, end: 10 }],
				symbols: [],
				source: "hunks" as const,
			},
		};

		expect(isLineInScope(scope, "src/a.ts", 7)).toBe(true);
		expect(isLineInScope(scope, "src/a.ts", 11)).toBe(false);
		expect(isLineInScope(scope, "src/b.ts", 7)).toBe(false);
	});

	test("mergeRanges une sobrepostos e adjacentes", () => {
		expect(
			mergeRanges([
				{ start: 10, end: 12 },
				{ start: 11, end: 15 },
				{ start: 16, end: 18 },
				{ start: 30, end: 30 },
			]),
		).toEqual([
			{ start: 10, end: 18 },
			{ start: 30, end: 30 },
		]);
	});

	test("formatadores compactos", () => {
		expect(formatRanges([])).toBe("sem linhas alteradas");
		expect(
			formatRanges([
				{ start: 10, end: 14 },
				{ start: 22, end: 22 },
			]),
		).toBe("10-14, 22");
		expect(
			formatSymbols([
				{ name: "foo", kind: "function", startLine: 10, endLine: 14 },
			]),
		).toBe("`foo` (10-14)");
		expect(
			summarizeScope({
				"src/a.ts": {
					ranges: [{ start: 1, end: 2 }],
					symbols: [
						{ name: "foo", kind: "function", startLine: 1, endLine: 2 },
					],
					source: "ast",
				},
			}),
		).toEqual({ files: 1, ranges: 1, symbols: 1 });
	});
});
