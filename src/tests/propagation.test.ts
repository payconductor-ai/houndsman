/**
 * Propagação mecânica — cluster de micro-alterações e lacunas de importadores.
 *
 * Congela a heurística usada no brief para não ler N diffs de uma linha e para
 * apontar contratos cujos importadores ficaram fora do diff.
 */

import { describe, expect, test } from "bun:test";
import type { AstAnalysis, AstImpact } from "../core/ast/types";
import { detectPropagation, detectPropagationGaps } from "../core/propagation";
import type { ChurnMap } from "../core/types";

const files = Array.from({ length: 7 }, (_, index) => `src/f${index}.ts`);

function patchFor(line: string): Map<string, string> {
	return new Map(
		files.map((file) => [file, `@@ -1 +1 @@\n-  await pay(charge);\n+${line}`]),
	);
}

function churnFor(extra: ChurnMap = {}): ChurnMap {
	const base: ChurnMap = Object.fromEntries(
		files.map((file) => [file, { additions: 1, deletions: 1 }]),
	);
	return { ...base, ...extra };
}

describe("detectPropagation", () => {
	test("agrupa o padrão dominante e isola os outliers", () => {
		const patch = patchFor("  await pay(charge, true);");
		patch.set(
			"src/f6.ts",
			"@@ -1 +1 @@\n-  await pay(charge);\n+  await pay(charge, false);",
		);
		const cluster = detectPropagation(files, patch, churnFor());
		expect(cluster?.files).toEqual(files.slice(0, 6));
		expect(cluster?.lines).toEqual(["await pay(charge, true);"]);
		expect(cluster?.outliers).toEqual([
			{ file: "src/f6.ts", lines: ["await pay(charge, false);"] },
		]);
	});

	test("ignora arquivos com churn acima do limite de micro-alteração", () => {
		const patch = patchFor("  await pay(charge, true);");
		patch.set("src/big.ts", "+  await pay(charge, true);");
		const cluster = detectPropagation([...files, "src/big.ts"], patch, {
			...churnFor(),
			"src/big.ts": { additions: 40, deletions: 0 },
		});
		expect(cluster?.files).not.toContain("src/big.ts");
	});

	test("sem grupo dominante devolve null", () => {
		const patch = new Map(
			files.slice(0, 3).map((file) => [file, "+  await pay(charge, true);"]),
		);
		expect(detectPropagation(files.slice(0, 3), patch, churnFor())).toBeNull();
	});
});

describe("detectPropagationGaps", () => {
	const analysis = {
		facts: {},
		delta: {
			addedSymbols: [],
			removedSymbols: [],
			modifiedSymbols: [],
			changedSignatures: [
				{
					name: "pay",
					before: "pay(charge)",
					after: "pay(charge, x)",
					exported: true,
				},
			],
			changedExports: [],
			addedImports: [],
			removedImports: [],
		},
	} as unknown as AstAnalysis;
	const impact = {
		affectedFiles: [],
		importers: {
			"src/types.ts": ["src/a.ts", "src/b.ts"],
			"src/other.ts": ["src/c.ts"],
		},
		exportedChanges: [],
	} as unknown as AstImpact;

	test("lista só importadores que não estão no diff", () => {
		const gaps = detectPropagationGaps(
			["src/types.ts", "src/other.ts"],
			new Map([["src/types.ts", analysis]]),
			impact,
			new Set(["src/a.ts"]),
		);
		expect(gaps).toEqual([{ file: "src/types.ts", importers: ["src/b.ts"] }]);
	});

	test("ignora mudança que não toca contrato exportado", () => {
		const internal = {
			...analysis,
			delta: {
				...analysis.delta,
				changedSignatures: [
					{ name: "pay", before: "pay(a)", after: "pay(b)", exported: false },
				],
			},
		} as unknown as AstAnalysis;
		expect(
			detectPropagationGaps(
				["src/types.ts"],
				new Map([["src/types.ts", internal]]),
				impact,
				new Set(),
			),
		).toEqual([]);
	});
});
