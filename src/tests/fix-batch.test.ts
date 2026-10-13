import { describe, expect, test } from "bun:test";
import type { FindingState, FindingsStateFile } from "../core/findings-state";
import {
	buildFixBatch,
	chooseGrouping,
	fixQueue,
	groupFindings,
} from "../core/fix-batch";
import type { Severity } from "../core/types";

let seq = 0;

/** Finding de teste com defaults sensatos. */
function f(
	partial: Partial<FindingState> & { file: string; rule: string; severity: Severity },
): FindingState {
	seq++;
	return {
		id: partial.id ?? `id${seq}`,
		fingerprint: partial.fingerprint ?? `fp${seq}`,
		watchdogIds: partial.watchdogIds ?? ["alpha"],
		rule: partial.rule,
		severity: partial.severity,
		file: partial.file,
		line: partial.line ?? 1,
		message: partial.message ?? "m",
		action: partial.action ?? "a",
		evidence: partial.evidence,
		anchor: null,
		count: partial.count ?? 1,
		present: partial.present ?? true,
		decision: partial.decision ?? "execute",
		comment: partial.comment,
		execState: partial.execState ?? "pending",
		createdAt: "",
		updatedAt: "",
		history: [],
	};
}

function stateOf(findings: FindingState[]): FindingsStateFile {
	return {
		version: 2,
		branch: "feature/x",
		slug: "feature-x",
		updatedAt: "",
		order: findings.map((item) => item.id),
		findings: Object.fromEntries(findings.map((item) => [item.id, item])),
	};
}

// ---------------------------------------------------------------------------
// chooseGrouping (heurística determinística)
// ---------------------------------------------------------------------------

describe("chooseGrouping", () => {
	test("prefere arquivo quando há poucos arquivos com coesão", () => {
		const findings = ["f1", "f2", "f3"].flatMap((file, i) => [
			f({
				file,
				rule: `r${i * 2 + 1}`,
				severity: "attention",
				watchdogIds: [`w${i}`],
			}),
			f({ file, rule: `r${i * 2 + 2}`, severity: "nit", watchdogIds: [`w${i}`] }),
		]);
		expect(chooseGrouping(findings)).toBe("file");
	});

	test("prefere regra quando uma regra domina vários arquivos", () => {
		const findings = ["f1", "f2", "f3", "f4", "f5", "f6"].map((file, i) =>
			f({
				file,
				rule: i < 3 ? "r1" : "r2",
				severity: "attention",
				watchdogIds: [`w${i}`],
			}),
		);
		expect(chooseGrouping(findings)).toBe("rule");
	});

	test("cai em watchdog quando nem arquivo nem regra têm coesão", () => {
		const findings = ["f1", "f2", "f3", "f4", "f5", "f6"].map((file, i) =>
			f({
				file,
				rule: `r${Math.min(i, 4)}`,
				severity: "attention",
				watchdogIds: [i < 3 ? "w1" : "w2"],
			}),
		);
		expect(chooseGrouping(findings)).toBe("watchdog");
	});

	test("sem elegíveis (tudo singleton), cai em file", () => {
		const findings = ["f1", "f2"].map((file, i) =>
			f({ file, rule: `r${i}`, severity: "nit", watchdogIds: [`w${i}`] }),
		);
		expect(chooseGrouping(findings)).toBe("file");
	});

	test("fila vazia devolve file", () => {
		expect(chooseGrouping([])).toBe("file");
	});
});

describe("groupFindings", () => {
	test("agrupa por arquivo com chaves prefixadas", () => {
		const findings = [
			f({ file: "src/a.ts", rule: "r1", severity: "attention" }),
			f({ file: "src/a.ts", rule: "r2", severity: "nit" }),
			f({ file: "src/b.ts", rule: "r3", severity: "nit" }),
		];
		const groups = groupFindings(findings, "file");
		expect(groups.size).toBe(2);
		expect(groups.get("file:src/a.ts")).toHaveLength(2);
		expect(groups.get("file:src/b.ts")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// fixQueue
// ---------------------------------------------------------------------------

describe("fixQueue", () => {
	test("só execute, presentes e não done; includeDone inclui", () => {
		const done = f({
			file: "a.ts",
			rule: "r1",
			severity: "attention",
			execState: "done",
		});
		const pending = f({ file: "a.ts", rule: "r2", severity: "attention" });
		const ignored = f({
			file: "a.ts",
			rule: "r3",
			severity: "attention",
			decision: "ignore",
		});
		const absent = f({
			file: "a.ts",
			rule: "r4",
			severity: "attention",
			present: false,
		});
		const state = stateOf([done, pending, ignored, absent]);

		expect(fixQueue(state).map((item) => item.id)).toEqual([pending.id]);
		expect(fixQueue(state, { includeDone: true }).map((item) => item.id)).toEqual([
			done.id,
			pending.id,
		]);
	});

	test("filtra por severidade", () => {
		const blocking = f({ file: "a.ts", rule: "r1", severity: "blocking" });
		const nit = f({ file: "a.ts", rule: "r2", severity: "nit" });
		const state = stateOf([blocking, nit]);
		expect(fixQueue(state, { severity: "blocking" }).map((item) => item.id)).toEqual([
			blocking.id,
		]);
	});
});

// ---------------------------------------------------------------------------
// buildFixBatch
// ---------------------------------------------------------------------------

/** Fila coesa em 2 arquivos / 2 watchdogs (arquivo e watchdog empatam → file). */
function coesaState(): FindingsStateFile {
	return stateOf([
		f({ file: "src/a.ts", rule: "r1", severity: "blocking", watchdogIds: ["alpha"] }),
		f({
			file: "src/a.ts",
			rule: "r2",
			severity: "attention",
			watchdogIds: ["alpha"],
		}),
		f({
			file: "src/a.ts",
			rule: "r3",
			severity: "attention",
			watchdogIds: ["alpha"],
		}),
		f({ file: "src/a.ts", rule: "r4", severity: "nit", watchdogIds: ["alpha"] }),
		f({ file: "src/b.ts", rule: "r5", severity: "attention", watchdogIds: ["beta"] }),
		f({
			file: "src/b.ts",
			rule: "r6",
			severity: "suggestion",
			watchdogIds: ["beta"],
		}),
	]);
}

describe("buildFixBatch", () => {
	test("escolhe o agrupamento e devolve grupo atual + outros grupos", () => {
		const result = buildFixBatch(coesaState());
		expect(result.dimension).toBe("file");
		expect(result.totals).toEqual({ queue: 6, groups: 2, returned: 4 });
		expect(result.current.key).toBe("file:src/a.ts");
		expect(result.current.total).toBe(4);
		expect(result.current.findings).toHaveLength(4);
		expect(result.current.remaining).toBe(0);
		expect(result.others).toHaveLength(1);
		expect(result.others[0].key).toBe("file:src/b.ts");
		expect(result.others[0].count).toBe(2);
	});

	test("pagina o grupo atual com pageSize", () => {
		const result = buildFixBatch(coesaState(), { pageSize: 2 });
		expect(result.current.returned).toBe(2);
		expect(result.current.remaining).toBe(2);
		expect(result.totals.returned).toBe(2);
	});

	test("--group foca um grupo específico", () => {
		const result = buildFixBatch(coesaState(), { group: "file:src/b.ts" });
		expect(result.current.key).toBe("file:src/b.ts");
		expect(result.current.total).toBe(2);
		expect(result.others).toHaveLength(1);
		expect(result.others[0].key).toBe("file:src/a.ts");
	});

	test("--group inexistente lança com as chaves disponíveis", () => {
		expect(() => buildFixBatch(coesaState(), { group: "file:nao-existe" })).toThrow(
			/não encontrado/,
		);
	});

	test("--severity filtra a fila", () => {
		const result = buildFixBatch(coesaState(), { severity: "blocking" });
		expect(result.totals.queue).toBe(1);
		expect(result.current.key).toBe("file:src/a.ts");
		expect(result.current.total).toBe(1);
		expect(result.others).toHaveLength(0);
	});

	test("fila vazia devolve lote vazio", () => {
		const state = stateOf([
			f({ file: "a.ts", rule: "r1", severity: "attention", decision: "pending" }),
		]);
		const result = buildFixBatch(state);
		expect(result.totals).toEqual({ queue: 0, groups: 0, returned: 0 });
		expect(result.current.findings).toHaveLength(0);
		expect(result.others).toHaveLength(0);
	});

	test("outros grupos trazem o mix de severidade", () => {
		const result = buildFixBatch(coesaState());
		expect(result.others[0].bySeverity).toEqual({
			blocking: 0,
			attention: 1,
			suggestion: 1,
			nit: 0,
		});
	});
});
