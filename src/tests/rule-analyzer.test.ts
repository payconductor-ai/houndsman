/**
 * RuleAnalyzer — polaridade, categoria, sinais e hints.
 */

import { describe, expect, test } from "bun:test";
import { RuleAnalyzer } from "../harness/investigation/rule-analyzer";

const analyzer = new RuleAnalyzer();

describe("RuleAnalyzer", () => {
	test("detecta polaridade explícita", () => {
		const [avoid, promote] = analyzer.analyze([
			{ severity: "blocking", text: "Evitar: chamar banco diretamente em rotas." },
			{ severity: "attention", text: "Promover: usar `logger` estruturado." },
		]);
		expect(avoid?.intent).toBe("avoid");
		expect(promote?.intent).toBe("promote");
	});

	test("classifica categoria por keywords", () => {
		const [data, tests] = analyzer.analyze([
			{
				severity: "attention",
				text: "Evitar: query direta no banco sem migration.",
			},
			{ severity: "nit", text: "Promover: cobertura de teste no handler." },
		]);
		expect(data?.category).toBe("data");
		expect(tests?.category).toBe("tests");
	});

	test("extrai sinais de backticks e hints (confiança alta)", () => {
		const [analysis] = analyzer.analyze([
			{
				severity: "blocking",
				text: "Evitar: usar `db.query` fora do service.",
				hints: {
					symbols: ["OrderService"],
					imports: ["db"],
					checks: ["symbol_context"],
				},
			},
		]);
		expect(analysis?.confidence).toBe("high");
		expect(analysis?.signals.some((signal) => signal.value === "OrderService")).toBe(
			true,
		);
		expect(analysis?.signals.some((signal) => signal.value === "db")).toBe(true);
		expect(analysis?.checks.some((check) => check.tool === "symbol_context")).toBe(
			true,
		);
	});

	test("keywords ignoram stopwords", () => {
		const [analysis] = analyzer.analyze([
			{ severity: "nit", text: "Nunca usar any em produção" },
		]);
		expect(analysis?.keywords).not.toContain("nunca");
		expect(analysis?.keywords).toContain("produção");
	});
});
