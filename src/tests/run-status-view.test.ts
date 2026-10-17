/**
 * View do status na sidebar — timeout só vale quando há heartbeat de execução.
 * `updatedAt` (triagem/sync) não deve simular uma revisão em andamento.
 */

import { describe, expect, test } from "bun:test";
import {
	describeRunStatus,
	REVIEW_TIMEOUT_MS,
	STATUS_TIMEOUT_MS,
} from "../server/client/utils/constants";
import type { RunSummary, Summary } from "../server/client/utils/types";

const summary: Summary = {
	total: 0,
	present: 0,
	byDecision: { pending: 0, execute: 0, ignore: 0 },
	byExecState: { pending: 0, in_progress: 0, done: 0, stale: 0 },
	bySeverity: { blocking: 0, attention: 0, suggestion: 0, nit: 0 },
};

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function run(overrides: Partial<RunSummary>): RunSummary {
	return {
		slug: "feature-x",
		branch: "feature/x",
		summary,
		...overrides,
	};
}

describe("describeRunStatus", () => {
	test("heartbeat recente mantém o status de execução", () => {
		expect(
			describeRunStatus(
				run({ status: "reviewing", heartbeatAt: iso(-60_000) }),
				NOW,
			),
		).toEqual({ kind: "reviewing", label: "Revisando", timeout: false });
	});

	test("heartbeat antigo vira timeout", () => {
		expect(
			describeRunStatus(
				run({
					status: "reviewing",
					heartbeatAt: iso(-REVIEW_TIMEOUT_MS - 1_000),
				}),
				NOW,
			),
		).toEqual({ kind: "timeout", label: "Timeout na revisão", timeout: true });
	});

	test("updatedAt recente não mascara heartbeat antigo", () => {
		expect(
			describeRunStatus(
				run({
					status: "reviewing",
					updatedAt: iso(-1_000),
					heartbeatAt: iso(-REVIEW_TIMEOUT_MS - 1_000),
				}),
				NOW,
			)?.timeout,
		).toBe(true);
	});

	test("sem heartbeat não inventa revisão em andamento", () => {
		expect(
			describeRunStatus(run({ status: "reviewing", updatedAt: iso(-1_000) }), NOW),
		).toBeNull();
	});

	test("status terminal aparece normalmente sem heartbeat", () => {
		expect(describeRunStatus(run({ status: "review_done" }), NOW)).toEqual({
			kind: "review_done",
			label: "Revisão pronta",
			timeout: false,
		});
	});

	test("correção também usa heartbeat para timeout", () => {
		expect(
			describeRunStatus(
				run({
					status: "fixing",
					heartbeatAt: iso(-STATUS_TIMEOUT_MS - 1_000),
				}),
				NOW,
			),
		).toEqual({ kind: "timeout", label: "Timeout na correção", timeout: true });
	});
});
