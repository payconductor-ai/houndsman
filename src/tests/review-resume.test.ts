/**
 * Resumo final (`review-resume.md`) — conteúdo de negócio + pontos técnicos,
 * determinístico e limitado a `RESUME_MAX_CHARS`.
 */

import { describe, expect, test } from "bun:test";
import {
	RESUME_MAX_CHARS,
	type ResumeClassification,
	renderReviewResume,
} from "../core/renderers/resume-renderer";
import type { MergedFinding } from "../core/report-builder";

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

describe("renderReviewResume", () => {
	test("une contexto de negócio e pontos técnicos", () => {
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
			nameOf: (id) => id.toUpperCase(),
		});

		expect(md).toContain("# Resumo da revisão — feat/x");
		expect(md).toContain("**Data:** 2026-10-17");
		expect(md).toContain("❌ Mudanças necessárias");
		expect(md).toContain("Entregar a feature X.");
		expect(md).toContain("**Por quê:** Reduzir o esforço manual.");
		expect(md).toContain("- Novo fluxo de cadastro.");
		expect(md).not.toContain("## Números");
		expect(md).toContain("`src/a.ts:1` — quebra o cadastro _(ALPHA)_");
		expect(md).toContain("`src/b.ts` — mensagem _(ALPHA)_");
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
		expect(md).toContain("- Nenhum bloqueio ou ponto de atenção.");
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
				changeSummary: ["a".repeat(200), "b".repeat(200)],
			},
			classification,
			findings,
		});

		expect(md.length).toBeLessThanOrEqual(RESUME_MAX_CHARS);
		expect(md.endsWith("…")).toBe(true);
	});
});
