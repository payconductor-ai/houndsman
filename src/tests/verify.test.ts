import { describe, expect, test } from "bun:test";
import { buildAnchor } from "../core/finding-anchor";
import {
	emptyState,
	type FindingState,
	type FindingsStateFile,
} from "../core/findings-state";
import { type JevClient, JevVerifier } from "../core/jev";
import {
	applyJev,
	applyResolutions,
	selectVerifiable,
	summarizeVerify,
	verifyLocal,
} from "../core/verify";

const CONTENT = ["function a() {", '\tconsole.log("x");', "}"].join("\n");
const FIXED = ["function a() {", "}"].join("\n");
const ANCHOR = buildAnchor(CONTENT, 2);

/** Finding mínimo, com overrides. */
function makeFinding(overrides: Partial<FindingState> = {}): FindingState {
	return {
		id: "f1",
		fingerprint: "fp",
		watchdogIds: ["alpha"],
		rule: "Evitar console.log",
		severity: "attention",
		file: "f.ts",
		line: 2,
		message: "console.log",
		action: "remover",
		anchor: ANCHOR,
		count: 1,
		present: true,
		decision: "execute",
		execState: "in_progress",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		history: [],
		...overrides,
	};
}

function withFindings(findings: FindingState[]): FindingsStateFile {
	const state = emptyState("main");
	for (const finding of findings) state.findings[finding.id] = finding;
	return state;
}

describe("verifyLocal", () => {
	test("âncora presente ⇒ persisting (definitivo)", () => {
		const [entry] = verifyLocal([makeFinding()], () => CONTENT);
		expect(entry.status).toBe("persisting");
		expect(entry.basis).toBe("anchor");
		expect(entry.ambiguous).toBe(false);
	});

	test("âncora sumida ⇒ resolved provisório e ambíguo", () => {
		const [entry] = verifyLocal([makeFinding()], () => FIXED);
		expect(entry.status).toBe("resolved");
		expect(entry.ambiguous).toBe(true);
	});

	test("arquivo ausente ⇒ file-missing", () => {
		const [entry] = verifyLocal([makeFinding()], () => null);
		expect(entry.status).toBe("file-missing");
		expect(entry.ambiguous).toBe(false);
	});

	test("sem âncora ⇒ uncertain e ambíguo", () => {
		const [entry] = verifyLocal([makeFinding({ anchor: null })], () => CONTENT);
		expect(entry.status).toBe("uncertain");
		expect(entry.ambiguous).toBe(true);
	});
});

describe("applyJev", () => {
	test("alta confiança confirma persistência; baixa confirma resolução", () => {
		const entries = verifyLocal(
			[
				makeFinding({ id: "removed", anchor: buildAnchor(CONTENT, 2) }),
				makeFinding({ id: "noanchor", anchor: null }),
			],
			() => FIXED,
		);
		const applied = applyJev(
			entries,
			new Map([
				["removed", 0.9],
				["noanchor", 0.1],
			]),
			0.6,
		);
		expect(applied).toBe(2);
		const byId = (id: string) => entries.find((entry) => entry.id === id);
		expect(byId("removed")?.status).toBe("persisting");
		expect(byId("removed")?.basis).toBe("jev");
		expect(byId("removed")?.confidence).toBe(0.9);
		expect(byId("noanchor")?.status).toBe("resolved");
	});

	test("id sem resposta mantém o provisório local (fail-open)", () => {
		const entries = verifyLocal([makeFinding()], () => FIXED);
		applyJev(entries, new Map(), 0.6);
		expect(entries[0].status).toBe("resolved");
		expect(entries[0].basis).toBe("anchor");
	});
});

describe("summarizeVerify / applyResolutions", () => {
	test("conta por status e marca os resolved como done", () => {
		const findings = [
			makeFinding({ id: "keeps", file: "keeps.ts" }),
			makeFinding({ id: "fixed", file: "fixed.ts" }),
			makeFinding({ id: "gone", file: "gone.ts" }),
		];
		const reader = (path: string): string | null =>
			path === "gone.ts" ? null : path === "fixed.ts" ? FIXED : CONTENT;
		const entries = verifyLocal(findings, reader);

		const summary = summarizeVerify(entries);
		expect(summary.persisting).toBe(1);
		expect(summary.resolved).toBe(1);
		expect(summary["file-missing"]).toBe(1);

		const state = withFindings(findings);
		const changed = applyResolutions(state, entries);
		expect(changed).toEqual(["fixed"]);
		expect(state.findings.fixed.execState).toBe("done");
		expect(state.findings.fixed.history.at(-1)?.by).toBe("verify");
		expect(state.findings.keeps.execState).toBe("in_progress");
		expect(state.findings.gone.execState).toBe("in_progress");
	});
});

describe("selectVerifiable", () => {
	test("inclui presentes e exclui ignore/ausentes", () => {
		const state = withFindings([
			makeFinding({ id: "p", decision: "pending" }),
			makeFinding({ id: "e", decision: "execute" }),
			makeFinding({ id: "i", decision: "ignore" }),
			makeFinding({ id: "absent", present: false }),
		]);
		expect(
			selectVerifiable(state)
				.map((finding) => finding.id)
				.sort(),
		).toEqual(["e", "p"]);
	});
});

describe("JevVerifier", () => {
	test("sem chave ⇒ nada confirmado (fail-open)", async () => {
		const client = { isConfigured: () => false } as unknown as JevClient;
		const outcome = await new JevVerifier(client).verify([
			{ id: "a", file: "f.ts", rule: "r", foundAtSha: "old" },
		]);
		expect(outcome.checked).toBe(0);
		expect(outcome.skipped).toBe(1);
		expect(outcome.reason).toContain("TYPESAFE_API_KEY");
	});

	test("sem casos ⇒ vazio", async () => {
		const client = { isConfigured: () => true } as unknown as JevClient;
		const outcome = await new JevVerifier(client).verify([]);
		expect(outcome.checked).toBe(0);
		expect(outcome.skipped).toBe(0);
	});
});
