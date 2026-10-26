/**
 * Golden set — parse, casamento por âncora e relatório.
 *
 * O ponto do golden é trocar "quantos findings" por recall/precisão sobre
 * defeitos confirmados; os testes cobrem a âncora (arquivo + faixa + trecho),
 * a severidade mínima e o uso único de cada finding.
 */

import { describe, expect, test } from "bun:test";
import {
	commitMatches,
	type GoldenFinding,
	type GoldenSet,
	goldenToJson,
	parseGoldenSet,
	renderGoldenReport,
	scoreGolden,
} from "../core/golden";

function finding(over: Partial<GoldenFinding> = {}): GoldenFinding {
	return {
		fingerprint: "fp",
		file: "src/a.ts",
		line: 100,
		rule: "Domínio: x",
		severity: "attention",
		message: "mensagem",
		watchdogs: ["general"],
		...over,
	};
}

const set: GoldenSet = {
	version: 1,
	title: "PR",
	commit: "56b5213",
	expected: [
		{ id: "seller-key", file: "src/a.ts", line: 116, match: "sellerApiKey" },
		{ id: "split", file: "src/b.ts", line: 706, severity: "attention" },
	],
};

describe("golden — parse", () => {
	test("aceita o objeto com `expected` e normaliza caminhos", () => {
		const parsed = parseGoldenSet({
			title: "PR",
			commit: "abc",
			expected: [{ id: "x", file: ".\\src\\a.ts", line: 3 }],
		});
		expect(parsed.set?.title).toBe("PR");
		expect(parsed.set?.expected[0].file).toBe("src/a.ts");
	});

	test("aceita lista direta e ignora itens sem id/file com aviso", () => {
		const parsed = parseGoldenSet([
			{ id: "ok", file: "a.ts" },
			{ id: "sem-file" },
			"lixo",
		]);
		expect(parsed.set?.expected).toHaveLength(1);
		expect(parsed.warnings).toHaveLength(2);
	});

	test("sem expectativas válidas não há set", () => {
		expect(parseGoldenSet({ expected: [] }).set).toBeNull();
		expect(parseGoldenSet(null).set).toBeNull();
	});

	test("severidade inválida é descartada (não vira filtro)", () => {
		const parsed = parseGoldenSet({
			expected: [{ id: "x", file: "a.ts", severity: "urgente" }],
		});
		expect(parsed.set?.expected[0].severity).toBeUndefined();
	});
});

describe("golden — score", () => {
	test("casa por arquivo + tolerância + trecho", () => {
		const score = scoreGolden(set, [
			finding({ file: "src/a.ts", line: 130, message: "sellerApiKey vaza" }),
		]);
		expect(score.matched.map((item) => item.expectation.id)).toEqual(["seller-key"]);
		expect(score.missed.map((item) => item.id)).toEqual(["split"]);
		expect(score.recall).toBe(0.5);
	});

	test("fora da tolerância não casa", () => {
		const score = scoreGolden(set, [
			finding({ file: "src/a.ts", line: 400, message: "sellerApiKey vaza" }),
		]);
		expect(score.matched).toHaveLength(0);
	});

	test("exige severidade mínima", () => {
		const score = scoreGolden(set, [
			finding({ file: "src/b.ts", line: 710, severity: "nit" }),
		]);
		expect(score.missed.map((item) => item.id)).toEqual(["seller-key", "split"]);
	});

	test("um finding não comprova dois defeitos", () => {
		const duplicated: GoldenSet = {
			version: 1,
			expected: [
				{ id: "a", file: "src/a.ts", line: 10 },
				{ id: "b", file: "src/a.ts", line: 12 },
			],
		};
		const score = scoreGolden(duplicated, [finding({ file: "src/a.ts", line: 11 })]);
		expect(score.matched).toHaveLength(1);
		expect(score.missed.map((item) => item.id)).toEqual(["b"]);
	});

	test("escolhe o candidato mais próximo da âncora", () => {
		const score = scoreGolden(set, [
			finding({ file: "src/a.ts", line: 145, message: "sellerApiKey vaza" }),
			finding({ file: "src/a.ts", line: 117, message: "sellerApiKey vaza" }),
		]);
		expect(score.matched[0].finding.line).toBe(117);
		expect(score.unexpected).toHaveLength(1);
	});

	test("precisão conta o que sobrou e colapsa âncoras repetidas", () => {
		const score = scoreGolden(set, [
			finding({ file: "src/a.ts", line: 116, message: "sellerApiKey" }),
			finding({ file: "src/a.ts", line: 116, message: "outra regra" }),
			finding({ file: "src/z.ts", line: 9, message: "ruído" }),
		]);
		expect(score.issues).toBe(2);
		expect(score.matched).toHaveLength(1);
		expect(score.unexpected).toHaveLength(2);
		expect(score.precision).toBeCloseTo(1 / 3);
	});

	test("sem findings, recall e precisão são zero", () => {
		const score = scoreGolden(set, []);
		expect(score.recall).toBe(0);
		expect(score.precision).toBe(0);
	});
});

describe("golden — relatório", () => {
	test("tabela por run, faltantes e fora do golden", () => {
		const runs = [
			{
				slug: "run-a",
				label: "otimizado-3",
				scope: "branch",
				findings: 1,
				score: scoreGolden(set, [
					finding({ file: "src/a.ts", line: 116, message: "sellerApiKey" }),
					finding({ file: "src/z.ts", line: 1, message: "ruído" }),
				]),
			},
		];
		const markdown = renderGoldenReport(set, runs);
		expect(markdown).toContain("| Run | Escopo |");
		expect(markdown).toContain("50% (1/2)");
		expect(markdown).toContain("`split` · `src/b.ts:706`");
		expect(markdown).toContain("Fora do golden (1)");
		expect(markdown).toContain("**commit de referência:** `56b5213`");
	});

	test("JSON é estável e inclui set + runs", () => {
		const json = JSON.parse(goldenToJson(set, [])) as {
			set: GoldenSet;
			runs: unknown[];
		};
		expect(json.set.expected).toHaveLength(2);
		expect(json.runs).toEqual([]);
	});

	test("commit divergente vira aviso, não erro", () => {
		expect(commitMatches("56b52138be18b49a", "56b52138be18b49a0000")).toBe(true);
		expect(commitMatches("56b52138", "9ff00000")).toBe(false);
		// Sem referência de um dos lados não há divergência afirmável.
		expect(commitMatches(undefined, "9ff00000")).toBe(true);
		expect(commitMatches("56b5213", undefined)).toBe(true);

		const markdown = renderGoldenReport(set, [
			{
				slug: "run-velha",
				label: "otimizado-3",
				scope: "branch",
				commit: "9ff0000aaaa",
				commitMismatch: true,
				findings: 0,
				score: scoreGolden(set, []),
			},
		]);
		expect(markdown).toContain("Commit divergente em 1 run(s)");
		expect(markdown).toContain("otimizado-3@9ff0000");
		expect(markdown).toContain("revalide o golden");
	});
});
