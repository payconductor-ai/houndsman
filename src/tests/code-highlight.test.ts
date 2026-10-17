/**
 * Destaque de código do evidence — tokenizer próprio, sem dependência.
 *
 * Garante que a inferência por extensão funciona, que o texto original é
 * preservado e que os tokens principais são classificados.
 */

import { describe, expect, test } from "bun:test";
import {
	highlightCode,
	languageFromFile,
	languageFromName,
} from "../server/client/utils/code-highlight";

/** O texto concatenado dos tokens deve ser idêntico ao input. */
function joined(tokens: { text: string }[]): string {
	return tokens.map((token) => token.text).join("");
}

describe("languageFromFile", () => {
	test("infere pela extensão e ignora extensões desconhecidas", () => {
		expect(languageFromFile("src/a.ts")).toBe("typescript");
		expect(languageFromFile("src/a.tsx")).toBe("typescript");
		expect(languageFromFile("scripts/a.py")).toBe("python");
		expect(languageFromFile("db/a.sql")).toBe("sql");
		expect(languageFromFile("charts/a.yaml")).toBe("yaml");
		expect(languageFromFile("README.md")).toBeNull();
		expect(languageFromFile("Makefile")).toBeNull();
		expect(languageFromFile("a.unknown")).toBeNull();
	});

	test("aliases de fence markdown", () => {
		expect(languageFromName("ts")).toBe("typescript");
		expect(languageFromName("js")).toBe("javascript");
		expect(languageFromName("py")).toBe("python");
		expect(languageFromName("json")).toBe("json");
		expect(languageFromName("yml")).toBe("yaml");
		expect(languageFromName("cobol")).toBeNull();
		expect(languageFromName(null)).toBeNull();
	});
});

describe("highlightCode", () => {
	test("TypeScript: keywords, tipos, números, strings e comentários", () => {
		const input = 'const answer: number = 42; // resposta\nconst url = "https://x";';
		const result = highlightCode(input, "typescript");
		expect(result?.label).toBe("TypeScript");
		expect(joined(result?.tokens ?? [])).toBe(input);
		expect(result?.tokens.find((token) => token.text === "const")?.type).toBe(
			"keyword",
		);
		expect(result?.tokens.find((token) => token.text === "number")?.type).toBe(
			"type",
		);
		expect(result?.tokens.find((token) => token.text === "42")?.type).toBe("number");
		expect(result?.tokens.find((token) => token.text === "// resposta")?.type).toBe(
			"comment",
		);
		expect(result?.tokens.find((token) => token.text === '"https://x"')?.type).toBe(
			"string",
		);
	});

	test("Python: comentários com # e strings de três aspas", () => {
		const input = 'def greet(name):\n    """doc"""\n    return "hi"  # ok';
		const result = highlightCode(input, "python");
		expect(joined(result?.tokens ?? [])).toBe(input);
		expect(result?.tokens.find((token) => token.text === "def")?.type).toBe(
			"keyword",
		);
		expect(result?.tokens.find((token) => token.text === "return")?.type).toBe(
			"keyword",
		);
		expect(result?.tokens.find((token) => token.text === '"""doc"""')?.type).toBe(
			"string",
		);
		expect(result?.tokens.find((token) => token.text === "# ok")?.type).toBe(
			"comment",
		);
	});

	test("JSON: chave vira propriedade e literal vira keyword", () => {
		const input = '{"a": 1, "b": true}';
		const result = highlightCode(input, "json");
		expect(result?.label).toBe("JSON");
		expect(joined(result?.tokens ?? [])).toBe(input);
		expect(result?.tokens.find((token) => token.text === '"a"')?.type).toBe(
			"property",
		);
		expect(result?.tokens.find((token) => token.text === "true")?.type).toBe(
			"keyword",
		);
	});

	test("HTML: tag e atributo", () => {
		const input = '<div class="x">hi</div>';
		const result = highlightCode(input, "html");
		expect(joined(result?.tokens ?? [])).toBe(input);
		expect(result?.tokens.find((token) => token.text === "div")?.type).toBe(
			"keyword",
		);
		expect(result?.tokens.find((token) => token.text === "class")?.type).toBe(
			"property",
		);
	});

	test("YAML: chave no início da linha e comentário", () => {
		const input = "name: value # note";
		const result = highlightCode(input, "yaml");
		expect(joined(result?.tokens ?? [])).toBe(input);
		expect(result?.tokens.find((token) => token.text === "name")?.type).toBe(
			"property",
		);
		expect(result?.tokens.find((token) => token.text === "# note")?.type).toBe(
			"comment",
		);
	});

	test("sem linguagem/desconhecida devolve null", () => {
		expect(highlightCode("const x = 1", null)).toBeNull();
		expect(highlightCode("const x = 1", "cobol")).toBeNull();
	});
});
