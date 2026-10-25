/**
 * Resumo final (`review-resume.md`) — conteúdo de negócio + pontos técnicos
 * estruturais, determinístico e limitado a `RESUME_MAX_CHARS`.
 */

import { describe, expect, test } from "bun:test";
import {
	RESUME_MAX_CHARS,
	type ResumeClassification,
	renderReviewResume,
} from "../core/renderers/resume-renderer";
import type { MergedFinding } from "../core/report-builder";
import type { TechnicalSummary } from "../core/technical-summary";

function finding(overrides: Partial<MergedFinding> = {}): MergedFinding {
	return {
		rule: "regra",
		severity: "suggestion",
		file: "src/a.ts",
		line: 1,
		message: "mensagem",
		action: "ação",
		watchdogs: ["alpha"],
		...overrides,
	};
}

const classification: ResumeClassification = {
	files: {
		"src/a.ts": { status: "modified" },
		"src/b.ts": { status: "added" },
	},
	watchdogs: { alpha: ["src/a.ts"], beta: ["src/b.ts"] },
};

const technical: TechnicalSummary = {
	source: "ai",
	headSha: "abc123",
	overview: "Novo service `bin-lookup` com provider e repository.",
	highlights: [
		{
			area: "Contratos",
			detail: "`BinLookupProvider` (src/bin-lookup/provider.ts)",
		},
		{
			area: "Implementações",
			detail: "`BinLookupService` (src/bin-lookup/service.ts)",
		},
	],
};

describe("renderReviewResume", () => {
	test("une contexto de negócio e pontos técnicos estruturais", () => {
		const md = renderReviewResume({
			branch: "feat/x",
			date: "2026-10-17",
			context: {
				available: true,
				objective: "Entregar a feature X.",
				motivation: "Reduzir o esforço manual.",
				changeSummary: ["Novo fluxo de cadastro.", "Ajuste no relatório."],
			},
			classification,
			findings: [
				finding({ severity: "blocking", message: "quebra o cadastro" }),
				finding({ severity: "attention", file: "src/b.ts", line: undefined }),
			],
			technical,
		});

		expect(md).toContain("# Resumo da revisão — feat/x");
		expect(md).toContain("**Data:** 2026-10-17");
		expect(md).toContain("❌ Mudanças necessárias");
		expect(md).toContain("Entregar a feature X.");
		expect(md).toContain("**Por quê:** Reduzir o esforço manual.");
		expect(md).toContain("- Novo fluxo de cadastro.");
		expect(md).not.toContain("## Números");
		expect(md).toContain("## Pontos técnicos");
		expect(md).toContain("Novo service `bin-lookup`");
		expect(md).toContain("**Contratos** — `BinLookupProvider`");
		expect(md).toContain("**Implementações** — `BinLookupService`");
		expect(md).not.toContain("quebra o cadastro");
		expect(md.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
	});

	test("sem contexto da PR, cai no alcance da branch", () => {
		const md = renderReviewResume({
			branch: "main",
			classification,
			findings: [],
		});

		expect(md).toContain("Sem resumo de contexto da PR disponível.");
		expect(md).toContain("✅ Aprovado");
		expect(md).toContain("Sem mudanças estruturais detectadas nesta revisão.");
	});

	test("inclui cobertura por domínio, candidatos e conclusão", () => {
		const md = renderReviewResume({
			branch: "feat/x",
			date: "2026-10-17",
			classification,
			findings: [
				finding({ severity: "blocking" }),
				finding({ severity: "attention", file: "src/b.ts" }),
			],
			domains: [
				{
					id: "alpha",
					name: "Alpha",
					findings: 1,
					reviewedFiles: 1,
					expectedFiles: 2,
				},
				{
					id: "beta",
					name: "Beta",
					findings: 1,
					reviewedFiles: 1,
					expectedFiles: 1,
				},
			],
			candidates: [
				{
					watchdogId: "alpha",
					rule: "Suspeita X",
					severity: "attention",
					file: "src/c.ts",
					confidence: 0.7,
					questionKey: "q1",
				},
				{
					watchdogId: "alpha",
					rule: "regra",
					severity: "attention",
					file: "src/a.ts",
					confidence: 0.7,
					questionKey: "q2",
				},
			],
		});

		expect(md).toContain("## Cobertura por domínio");
		expect(md).toContain("| Alpha | 1 | 1/2 | 1 |");
		expect(md).toContain("| Beta | 1 | 1/1 | — |");
		expect(md).toContain("## Candidatos não verificados (1)");
		expect(md).toContain("Suspeita X");
		expect(md).not.toContain("`src/a.ts` ·");
		expect(md).toContain("## Conclusão");
		expect(md).toContain(
			"**Resumo:** 1 bloqueantes · 1 atenção · 0 sugestões · 0 nits.",
		);
	});

	test("respeita o teto de caracteres", () => {
		const findings = Array.from({ length: 40 }, (_, index) =>
			finding({
				severity: index % 2 === 0 ? "blocking" : "attention",
				file: `src/very/long/path/file-${index}.ts`,
				message: "x".repeat(300),
			}),
		);
		const md = renderReviewResume({
			branch: "main",
			context: {
				available: true,
				objective: "o".repeat(1000),
				motivation: "m".repeat(1000),
				changeSummary: ["a".repeat(300), "b".repeat(300)],
			},
			classification,
			findings,
			technical: {
				source: "deterministic",
				overview: "v".repeat(600),
				highlights: Array.from({ length: 10 }, (_, index) => ({
					area: `Área ${index}`,
					detail: "x".repeat(300),
				})),
			},
		});

		expect(md.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
		// O corte acontece no texto narrativo; tabelas e conclusão seguem inteiras.
		expect(md).toContain("\n…");
		expect(md).toContain("## Conclusão");
	});
});
