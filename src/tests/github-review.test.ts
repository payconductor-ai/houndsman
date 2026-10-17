/**
 * Testes do envio da revisão ao GitHub (`core/github-review.ts`).
 *
 * Usam um runner fake do `gh` — nenhum teste toca a rede/repositório real.
 */

import { describe, expect, test } from "bun:test";
import {
	emptyState,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsStateFile,
} from "../core/findings-state";
import {
	buildCommentBody,
	buildSubmitPreview,
	type GhResult,
	type GhRunner,
	type PrTarget,
	renderGeneralBody,
	resolvePrTarget,
	selectSubmitCandidates,
	submitFindings,
} from "../core/github-review";
import type { Severity } from "../core/types";

type FindingSpec = {
	id: string;
	severity?: Severity;
	decision?: FindingDecision;
	execState?: FindingExecState;
	line?: number | null;
	present?: boolean;
	rule?: string;
	file?: string;
	commentId?: number;
};

function finding(spec: FindingSpec): FindingState {
	return {
		id: spec.id,
		fingerprint: spec.id,
		watchdogIds: ["alpha"],
		rule: spec.rule ?? "Regra de teste",
		severity: spec.severity ?? "blocking",
		file: spec.file ?? "src/a.ts",
		line: spec.line === undefined ? 3 : spec.line,
		message: "mensagem",
		action: "corrigir",
		evidence: "const x = 1;",
		anchor: null,
		count: 1,
		present: spec.present ?? true,
		decision: spec.decision ?? "pending",
		execState: spec.execState ?? "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		history: [],
		github: spec.commentId
			? {
					commentId: spec.commentId,
					kind: "line",
					pr: 1,
					at: "2026-01-01T00:00:00.000Z",
				}
			: undefined,
	};
}

function stateWith(findings: FindingState[]): FindingsStateFile {
	const state = emptyState("feat/x");
	for (const item of findings) state.findings[item.id] = item;
	state.order = findings.map((item) => item.id);
	return state;
}

const TARGET: PrTarget = { number: 7, repo: "acme/app", headSha: "abc" };

function okComment(id: number): GhResult {
	return {
		ok: true,
		code: 0,
		stderr: "",
		stdout: JSON.stringify({ id, html_url: `https://x/${id}` }),
	};
}

/** Runner fake: o handler decide a resposta a partir dos args (os chamados ficam registrados). */
function fakeRunner(handler: (args: string[]) => GhResult): {
	runner: GhRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner: GhRunner = (args) => {
		calls.push(args);
		return handler(args);
	};
	return { runner, calls };
}

/** Respostas por tipo de destino: geral (issues), arquivo (subject_type=file) e linha. */
function endpointRunner(ids: { line?: number; file?: number; general?: number } = {}): {
	runner: GhRunner;
	calls: string[][];
} {
	return fakeRunner((args) => {
		if (args[1].includes("/issues/")) return okComment(ids.general ?? 900);
		if (args.includes("subject_type=file")) return okComment(ids.file ?? 800);
		return okComment(ids.line ?? 700);
	});
}

describe("selectSubmitCandidates", () => {
	const state = stateWith([
		finding({ id: "a", severity: "blocking", decision: "execute" }),
		finding({ id: "b", severity: "attention", decision: "ignore" }),
		finding({ id: "c", severity: "nit", line: null }),
		finding({ id: "d", decision: "execute", present: false }),
	]);

	test("exclui ignore e ausentes", () => {
		expect(selectSubmitCandidates(state).map((c) => c.id)).toEqual(["a", "c"]);
	});

	test("filtra por severidade e define a âncora", () => {
		const blocking = selectSubmitCandidates(state, { severities: ["blocking"] });
		expect(blocking.map((c) => c.id)).toEqual(["a"]);
		expect(blocking[0].kind).toBe("line");
		expect(selectSubmitCandidates(state, { severities: ["nit"] })[0].kind).toBe(
			"file",
		);
	});

	test("filtra por estado de execução", () => {
		const exec = selectSubmitCandidates(state, { execStates: ["pending"] });
		expect(exec.map((c) => c.id)).toEqual(["a", "c"]);
		expect(selectSubmitCandidates(state, { execStates: ["done"] })).toEqual([]);
	});

	test("marca sent/skip e respeita includeSent", () => {
		const sent = stateWith([finding({ id: "a", commentId: 99 })]);
		const [only] = selectSubmitCandidates(sent);
		expect(only.sent).toBe(true);
		expect(only.skip).toBe(true);
		expect(only.sentUrl).toBeUndefined();
		expect(selectSubmitCandidates(sent, { includeSent: true })[0].skip).toBe(false);
	});
});

describe("buildSubmitPreview", () => {
	test("disponível: conta linha/arquivo", () => {
		const state = stateWith([finding({ id: "a" }), finding({ id: "c", line: null })]);
		const preview = buildSubmitPreview(state, { ok: true, target: TARGET });
		expect(preview.available).toBe(true);
		expect(preview.target).toEqual(TARGET);
		expect(preview.totals).toMatchObject({
			candidates: 2,
			toSend: 2,
			line: 1,
			file: 1,
			sent: 0,
		});
	});

	test("indisponível propaga o motivo", () => {
		const preview = buildSubmitPreview(stateWith([]), {
			ok: false,
			reason: "sem gh",
		});
		expect(preview.available).toBe(false);
		expect(preview.reason).toBe("sem gh");
	});
});

describe("corpo dos comentários", () => {
	test("buildCommentBody inclui regra, ação e evidência", () => {
		const body = buildCommentBody(finding({ id: "a", rule: "Nunca usar any" }));
		expect(body).toContain("Nunca usar any");
		expect(body).toContain("**Ação:** corrigir");
		expect(body).toContain("const x = 1;");
		expect(body).toContain("houndsman");
	});

	test("renderGeneralBody lista os findings sem linha", () => {
		const body = renderGeneralBody([
			finding({ id: "a", rule: "Regra X", line: null }),
		]);
		expect(body).toContain("Regra X");
		expect(body).toContain("src/a.ts");
	});
});

describe("resolvePrTarget", () => {
	test("resolve número, repo e head", () => {
		const runner: GhRunner = () => ({
			ok: true,
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				number: 7,
				url: "https://github.com/acme/app/pull/7",
				headRefOid: "abc123",
			}),
		});
		const result = resolvePrTarget(runner, "feat/x");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.target).toEqual({
				number: 7,
				repo: "acme/app",
				headSha: "abc123",
				url: "https://github.com/acme/app/pull/7",
			});
		}
	});

	test("fail-open sem gh", () => {
		const runner: GhRunner = () => ({
			ok: false,
			code: 127,
			stdout: "",
			stderr: "command not found",
		});
		const result = resolvePrTarget(runner, "feat/x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("gh não instalado");
	});
});

describe("submitFindings", () => {
	test("posta na linha e no arquivo; grava o vínculo", () => {
		const state = stateWith([finding({ id: "a" }), finding({ id: "c", line: null })]);
		const { runner } = endpointRunner({ line: 100, file: 150, general: 200 });
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.posted).toHaveLength(2);
		expect(outcome.failed).toEqual([]);
		expect(outcome.general).toBeUndefined();
		expect(state.findings.a.github).toMatchObject({
			commentId: 100,
			kind: "line",
			pr: 7,
		});
		expect(state.findings.c.github).toMatchObject({
			commentId: 150,
			kind: "file",
			pr: 7,
		});
	});

	test("linha fora do diff cai no comentário de arquivo", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner } = fakeRunner((args) =>
			args.includes("subject_type=file")
				? okComment(150)
				: {
						ok: false,
						code: 422,
						stderr: "line must be part of the diff",
						stdout: "",
					},
		);
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.failed).toEqual([]);
		expect(outcome.general).toBeUndefined();
		expect(state.findings.a.github).toMatchObject({
			kind: "file",
			commentId: 150,
		});
	});

	test("o que não cola em linha nem arquivo vai para o comentário geral", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner } = fakeRunner((args) =>
			args[1].includes("/issues/")
				? okComment(200)
				: { ok: false, code: 422, stderr: "fora do diff", stdout: "" },
		);
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.failed).toHaveLength(1);
		expect(outcome.general?.ids).toEqual(["a"]);
		expect(state.findings.a.github?.kind).toBe("comment");
		expect(state.findings.a.github?.commentId).toBe(200);
	});

	test("pula já enviados (sem chamar o gh)", () => {
		const state = stateWith([finding({ id: "a", commentId: 55 })]);
		const { runner, calls } = endpointRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(calls).toHaveLength(0);
		expect(outcome.skipped).toHaveLength(1);
		expect(state.findings.a.github?.commentId).toBe(55);
	});

	test("manda commit_id e side=RIGHT na linha", () => {
		const state = stateWith([finding({ id: "a", line: 9 })]);
		const { runner, calls } = endpointRunner({ line: 100 });
		submitFindings({ state, target: TARGET, runner });

		const line = calls[0];
		expect(line).toContain("line=9");
		expect(line).toContain("side=RIGHT");
		expect(line).toContain("commit_id=abc");
		expect(line).toContain("path=src/a.ts");
	});

	test("finding sem linha usa subject_type=file", () => {
		const state = stateWith([finding({ id: "a", line: null })]);
		const { runner, calls } = endpointRunner({ file: 150 });
		submitFindings({ state, target: TARGET, runner });

		expect(calls[0]).toContain("subject_type=file");
		expect(calls[0]).not.toContain("side=RIGHT");
		expect(state.findings.a.github?.kind).toBe("file");
	});
});
