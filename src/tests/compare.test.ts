/**
 * Comparação A/B e identidade das variantes.
 *
 * Cobre o slug da run (URL/backend de arquivos), o diff de findings entre dois
 * snapshots e o parse de `--variant` no comando default.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompare } from "../core/commands/compare";
import { parseReviewArgs } from "../core/commands/review";
import {
	buildComparison,
	type ComparisonFinding,
	countBySeverity,
	type ReviewSnapshot,
	renderComparison,
} from "../core/compare";
import type { FindingsStateFile } from "../core/findings-state";
import { reviewSlug, sanitizeVariant } from "../core/report-builder";
import { buildRepoIdentity } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";

function finding(
	fingerprint: string,
	partial: Partial<ComparisonFinding> = {},
): ComparisonFinding {
	return {
		fingerprint,
		rule: "regra",
		severity: "attention",
		file: "src/a.ts",
		line: 10,
		message: "mensagem",
		watchdogs: ["alpha"],
		...partial,
	};
}

function snapshot(
	label: string,
	findings: ComparisonFinding[],
	variant?: string,
): ReviewSnapshot {
	return {
		label,
		slug: reviewSlug("feature/x", variant),
		branch: "feature/x",
		variant,
		headSha: "deadbeef",
		findings,
		bySeverity: countBySeverity(findings),
		coverage: { watchdogs: 2, files: 3, overflow: 0 },
		durationMs: 60_000,
	};
}

describe("reviewSlug / sanitizeVariant", () => {
	test("run principal usa o slug da branch", () => {
		expect(reviewSlug("feature/add-webhook")).toBe("feature-add-webhook");
		expect(reviewSlug("feature/x", "   ")).toBe("feature-x");
	});

	test("variante ganha sufixo legível + hash estável", () => {
		const baseline = reviewSlug("feature/x", "Baseline A");
		const optimized = reviewSlug("feature/x", "Baseline B");
		expect(baseline).toStartWith("feature-x--baseline-a-");
		expect(baseline).toBe(reviewSlug("feature/x", "Baseline A"));
		expect(baseline).not.toBe(optimized);
		expect(sanitizeVariant("  A/B  ")).toBe("a-b");
	});
});

describe("buildComparison", () => {
	const a = snapshot("A", [
		finding("f1", { severity: "attention", file: "src/a.ts" }),
		finding("f2", { severity: "suggestion", file: "src/b.ts", line: 2 }),
	]);
	const b = snapshot(
		"B",
		[
			finding("f1", { severity: "blocking", file: "src/a.ts" }),
			finding("f3", { severity: "blocking", file: "src/c.ts", line: 5 }),
		],
		"otimizado",
	);

	test("separa novos, sumidos e mudança de severidade", () => {
		const comparison = buildComparison(a, b);
		expect(comparison.onlyB.map((item) => item.fingerprint)).toEqual(["f3"]);
		expect(comparison.onlyA.map((item) => item.fingerprint)).toEqual(["f2"]);
		expect(comparison.common).toHaveLength(1);
		expect(comparison.severityChanged).toHaveLength(1);
		expect(comparison.severityChanged[0].a.severity).toBe("attention");
		expect(comparison.severityChanged[0].b.severity).toBe("blocking");
	});

	test("conta por severidade", () => {
		expect(a.bySeverity).toEqual({
			blocking: 0,
			attention: 1,
			suggestion: 1,
			nit: 0,
		});
		expect(b.bySeverity).toEqual({
			blocking: 2,
			attention: 0,
			suggestion: 0,
			nit: 0,
		});
	});

	test("renderiza a tabela e as listas", () => {
		const markdown = renderComparison(buildComparison(a, b));
		expect(markdown).toContain("# Comparação A/B — `feature/x`");
		expect(markdown).toContain("| Findings (presentes) | 2 | 2 | 0 |");
		expect(markdown).toContain("## Só em B (novos) (1)");
		expect(markdown).toContain("## Só em A (não apareceram em B) (1)");
		expect(markdown).toContain("## Severidade mudou (1)");
		expect(markdown).toContain("## Só em B");
	});

	test("expõe checklist e cobertura declarada do harness", () => {
		const withHarness: ReviewSnapshot = {
			...snapshot("B", []),
			harness: {
				checksExpected: 8,
				checksVerified: 6,
				checksGaps: 2,
				reviewedFiles: 11,
				skippedFiles: 3,
				undeclaredFiles: 4,
				businessScore: 20,
			},
		};
		const markdown = renderComparison(buildComparison(a, withHarness));
		expect(markdown).toContain("| Checklist verificado | — | 6/8 | — |");
		expect(markdown).toContain("| Arquivos sem declaração | — | 4 | — |");
		expect(markdown).toContain("| Modelo de intenção (score) | — | 20 | — |");
	});
});

describe("--variant", () => {
	test("é lido pelo parse do comando default", () => {
		const options = parseReviewArgs([
			"--branch",
			"feature/x",
			"--variant",
			" baseline ",
		]);
		expect(options.variant).toBe("baseline");
	});

	describe("runCompare", () => {
		test("lê as duas runs e grava o relatório na run B", () => {
			const dir = mkdtempSync(join(tmpdir(), "houndsman-compare-"));
			const storage = new SQLiteStorageProvider(join(dir, "houndsman.db"));
			try {
				const repo = buildRepoIdentity(null, dir);
				const main = storage.getOrCreateReview({
					repo,
					branch: "feature/x",
					slug: "feature-x",
				});
				const variant = storage.getOrCreateReview({
					repo,
					branch: "feature/x",
					variant: "otimizado",
					slug: "feature-x--otimizado-1a2b3c",
				});
				const state = (
					findings: FindingsStateFile["findings"],
				): FindingsStateFile => ({
					version: 2,
					branch: "feature/x",
					slug: "feature-x",
					updatedAt: "2026-01-01T00:00:00.000Z",
					order: Object.keys(findings),
					findings,
				});
				const baseFinding = {
					id: "ab12cd34ef",
					fingerprint: "fp-1",
					watchdogIds: ["alpha"],
					rule: "regra",
					severity: "attention" as const,
					file: "src/a.ts",
					line: 10,
					message: "mensagem",
					action: "ação",
					anchor: null,
					count: 1,
					present: true,
					decision: "pending" as const,
					execState: "pending" as const,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					history: [],
				};
				storage.writeFindings(main.id, state({ ab12cd34ef: baseFinding }));
				storage.writeFindings(
					variant.id,
					state({
						ab12cd34ef: baseFinding,
						ff00aa11bb: {
							...baseFinding,
							id: "ff00aa11bb",
							fingerprint: "fp-2",
							rule: "outra",
						},
					}),
				);
				storage.writeArtifact(main.id, {
					name: "manifest.json",
					kind: "manifest",
					content: JSON.stringify({
						watchdogs: [{ files: ["src/a.ts"], overflow: 0 }],
					}),
				});
				storage.writeArtifact(variant.id, {
					name: "prepare-report.json",
					kind: "prepare",
					content: JSON.stringify({ durationMs: 1_000, stages: [] }),
				});

				const result = runCompare(storage, repo, {
					branch: "feature/x",
					variantB: "otimizado",
				});
				expect(result.b.id).toBe(variant.id);
				expect(result.markdown).toContain("Só em B (novos) (1)");
				expect(
					storage.readArtifact(variant.id, result.artifacts.markdown)?.kind,
				).toBe("compare");
				expect(
					storage.readArtifact(variant.id, result.artifacts.json)?.content,
				).toContain("onlyB");
			} finally {
				storage.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test("vazio é rejeitado", () => {
		expect(() => parseReviewArgs(["--variant", "  "])).toThrow(
			"--variant não pode ser vazio",
		);
	});
});
