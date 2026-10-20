/**
 * Pontos técnicos estruturais do resumo final — builder determinístico e
 * validação do artefato `technical-summary.json`.
 */

import { describe, expect, test } from "bun:test";
import type { AstAnalysis, AstFacts, AstImpact } from "../core/ast/types";
import { buildTechnicalSummary, parseTechnicalSummary } from "../core/technical-summary";

const facts: AstFacts = {
	language: "typescript",
	symbols: [],
	imports: [],
	exports: [],
	decorators: [],
	hasSyntaxErrors: false,
};

function analysis(partial: Partial<AstAnalysis> = {}): AstAnalysis {
	return {
		facts,
		delta: {
			addedSymbols: [],
			removedSymbols: [],
			modifiedSymbols: [],
			changedSignatures: [],
			addedImports: [],
			removedImports: [],
			changedExports: [],
		},
		...partial,
	};
}

const classification = {
	files: {
		"src/bin-lookup/service.ts": { status: "added" },
		"src/bin-lookup/provider.ts": { status: "added" },
	},
	churn: {
		"src/bin-lookup/service.ts": { additions: 10, deletions: 0 },
		"src/bin-lookup/provider.ts": { additions: 5, deletions: 0 },
	},
} as const;

describe("buildTechnicalSummary", () => {
	test("extrai contratos, implementações, assinaturas e dependências do AST", () => {
		const ast = new Map<string, AstAnalysis>([
			[
				"src/bin-lookup/service.ts",
				analysis({
					delta: {
						addedSymbols: [
							{
								name: "BinLookupProvider",
								kind: "interface",
								exported: true,
								startLine: 1,
								endLine: 3,
							},
							{
								name: "BinLookupService",
								kind: "class",
								exported: true,
								startLine: 5,
								endLine: 20,
							},
						],
						removedSymbols: [],
						modifiedSymbols: [],
						changedSignatures: [
							{
								name: "lookup",
								before: "(bin: string)",
								after: "(bin: string, brand: string)",
								exported: true,
							},
						],
						addedImports: ["./provider", "axios"],
						removedImports: [],
						changedExports: [{ name: "legacy", change: "removed" }],
					},
				}),
			],
		]);

		const summary = buildTechnicalSummary({
			classification,
			ast,
			headSha: "abc",
		});

		expect(summary.source).toBe("deterministic");
		expect(summary.headSha).toBe("abc");
		const text = summary.highlights.map((item) => `${item.area}: ${item.detail}`);
		expect(text.join("\n")).toContain("Contratos: `BinLookupProvider`");
		expect(text.join("\n")).toContain("Implementações: `BinLookupService`");
		expect(text.join("\n")).toContain("Assinaturas alteradas: `lookup`");
		expect(text.join("\n")).toContain("Novas dependências: `axios`");
		expect(text.join("\n")).not.toContain("./provider");
		expect(text.join("\n")).toContain("Exports alterados: `legacy`");
	});

	test("sem AST, agrupa arquivos novos por diretório", () => {
		const summary = buildTechnicalSummary({ classification });
		expect(summary.highlights[0]).toEqual({
			area: "Estrutura",
			detail: "Novo diretório `src/bin-lookup` com 2 arquivo(s).",
		});
	});

	test("registra remoções e impacto", () => {
		const impact: AstImpact = {
			importers: { "src/bin-lookup/service.ts": ["src/a.ts"] },
			affectedFiles: ["src/a.ts"],
			exportedChanges: [
				{
					file: "src/bin-lookup/service.ts",
					symbol: "lookup",
					change: "removed",
				},
			],
		};
		const summary = buildTechnicalSummary({
			classification: {
				files: {
					"src/old.ts": { status: "deleted" },
					"src/bin-lookup/service.ts": { status: "modified" },
				},
				churn: {},
			},
			impact,
		});
		const text = summary.highlights.map((item) => `${item.area}: ${item.detail}`);
		expect(text.join("\n")).toContain("Remoções: `src/old.ts`");
		expect(text.join("\n")).toContain("Impacto: 1 arquivo(s) importam os alterados");
	});

	test("não gera destaques quando não há mudança estrutural", () => {
		const summary = buildTechnicalSummary({
			classification: { files: {}, churn: {} },
		});
		expect(summary.highlights).toEqual([]);
	});
});

describe("parseTechnicalSummary", () => {
	test("aceita artefato válido e normaliza o source", () => {
		const summary = parseTechnicalSummary({
			source: "deterministic",
			headSha: "abc",
			overview: "Estrutura",
			highlights: [{ area: "Contratos", detail: "`X`" }],
		});
		expect(summary?.source).toBe("deterministic");
		expect(summary?.highlights[0].area).toBe("Contratos");
	});

	test("rejeita conteúdo vazio ou inválido", () => {
		expect(parseTechnicalSummary(null)).toBeNull();
		expect(parseTechnicalSummary({})).toBeNull();
		expect(
			parseTechnicalSummary({ highlights: [{ area: "", detail: "" }] }),
		).toBeNull();
	});

	test("limita a seis destaques", () => {
		const summary = parseTechnicalSummary({
			highlights: Array.from({ length: 10 }, (_, index) => ({
				area: `Área ${index}`,
				detail: `Detalhe ${index}`,
			})),
		});
		expect(summary?.highlights).toHaveLength(6);
	});
});
