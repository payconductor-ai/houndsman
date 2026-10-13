import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FindingState, FindingsStateFile } from "../core/findings-state";
import {
	pingFindingsStatus,
	readRunStatus,
	statusAfterFindingsChange,
	writeRunStatus,
} from "../core/run-status";

function findingState(partial: Partial<FindingState>): FindingState {
	return {
		id: partial.id ?? "id",
		fingerprint: partial.fingerprint ?? "fp",
		watchdogIds: partial.watchdogIds ?? ["alpha"],
		rule: partial.rule ?? "r",
		severity: partial.severity ?? "attention",
		file: partial.file ?? "a.ts",
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
		version: 1,
		branch: "feature/x",
		slug: "feature-x",
		updatedAt: "",
		order: findings.map((item) => item.id),
		findings: Object.fromEntries(findings.map((item) => [item.id, item])),
	};
}

/** Diretório temporário isolado. */
function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "houndsman-run-status-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("run-status — arquivo", () => {
	test("grava, lê e preserva/restaura o startedAt", () => {
		withTempDir((dir) => {
			writeRunStatus(dir, {
				branch: "feature/x",
				status: "reviewing",
				resetStartedAt: true,
				now: "2026-01-01T00:00:00.000Z",
			});
			const first = readRunStatus(dir);
			expect(first?.status).toBe("reviewing");
			expect(first?.slug).toBe("feature-x");
			expect(first?.startedAt).toBe("2026-01-01T00:00:00.000Z");

			writeRunStatus(dir, {
				branch: "feature/x",
				status: "review_done",
				now: "2026-01-01T00:10:00.000Z",
			});
			const second = readRunStatus(dir);
			expect(second?.status).toBe("review_done");
			expect(second?.startedAt).toBe("2026-01-01T00:00:00.000Z");
			expect(second?.updatedAt).toBe("2026-01-01T00:10:00.000Z");

			writeRunStatus(dir, {
				branch: "feature/x",
				status: "reviewing",
				resetStartedAt: true,
				now: "2026-01-01T00:20:00.000Z",
			});
			expect(readRunStatus(dir)?.startedAt).toBe("2026-01-01T00:20:00.000Z");
		});
	});

	test("readRunStatus devolve null sem arquivo", () => {
		withTempDir((dir) => {
			expect(readRunStatus(dir)).toBeNull();
		});
	});
});

describe("statusAfterFindingsChange", () => {
	test("in_progress → fixing", () => {
		const state = stateOf([findingState({ execState: "in_progress" })]);
		expect(statusAfterFindingsChange("review_done", state)).toBe("fixing");
	});

	test("review_done + fila (triado, não iniciado) → mantém review_done", () => {
		const state = stateOf([
			findingState({ decision: "execute", execState: "pending" }),
		]);
		expect(statusAfterFindingsChange("review_done", state)).toBe("review_done");
	});

	test("fixing + fila → fixing", () => {
		const state = stateOf([
			findingState({ id: "a", execState: "done" }),
			findingState({ id: "b", execState: "pending" }),
		]);
		expect(statusAfterFindingsChange("fixing", state)).toBe("fixing");
	});

	test("fixing + fila vazia → fix_done", () => {
		const state = stateOf([findingState({ execState: "done" })]);
		expect(statusAfterFindingsChange("fixing", state)).toBe("fix_done");
	});

	test("done sem nunca ter iniciado → fix_done", () => {
		const state = stateOf([findingState({ execState: "done" })]);
		expect(statusAfterFindingsChange("review_done", state)).toBe("fix_done");
	});

	test("sem run.json e sem fix → fallback review_done", () => {
		const state = stateOf([
			findingState({ decision: "pending", execState: "pending" }),
		]);
		expect(statusAfterFindingsChange(null, state)).toBe("review_done");
	});
});

describe("pingFindingsStatus", () => {
	test("deriva do estado e grava o run.json", () => {
		withTempDir((dir) => {
			const state = stateOf([findingState({ execState: "in_progress" })]);
			const file = pingFindingsStatus(dir, state);
			expect(file.status).toBe("fixing");
			expect(readRunStatus(dir)?.status).toBe("fixing");
		});
	});
});
