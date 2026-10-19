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
	renderReviewBody,
	resolveFindingThreads,
	resolvePrTarget,
	selectSubmitCandidates,
	submitFindings,
	syncResolvedThreads,
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

/** Resposta OK do `gh` com um JSON. */
function okJson(payload: unknown): GhResult {
	return { ok: true, code: 0, stderr: "", stdout: JSON.stringify(payload) };
}

type ReviewRunnerOptions = {
	/** Revisão PENDING já existente. */
	pending?: { id: string; databaseId: number };
	/** Erro GraphQL ao consultar/criar a revisão. */
	lookupError?: string;
	/** Erro ao adicionar a thread da linha. */
	threadError?: string;
	/** Erro ao finalizar a revisão. */
	submitError?: string;
	/** Erro no comentário de arquivo (REST). */
	fileError?: boolean;
	lineId?: number;
	fileId?: number;
	generalId?: number;
	/** Threads do PR (comentário → conversa). */
	threads?: { id: string; commentId: number; isResolved?: boolean }[];
	/** Erro GraphQL ao listar/resolver threads. */
	threadsError?: string;
};

/**
 * Runner fake do `gh`: responde às queries/mutations GraphQL da revisão e aos
 * endpoints REST de fallback. Os chamados ficam registrados.
 */
function reviewRunner(options: ReviewRunnerOptions = {}): {
	runner: GhRunner;
	calls: string[][];
} {
	return fakeRunner((args) => {
		if (args[0] === "api" && args[1] === "graphql") {
			const query =
				args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ??
				"";
			if (query.includes("states: [PENDING]")) {
				if (options.lookupError) {
					return okJson({ errors: [{ message: options.lookupError }] });
				}
				return okJson({
					data: {
						repository: {
							pullRequest: {
								id: "PR_1",
								reviews: {
									nodes: options.pending
										? [
												{
													id: options.pending.id,
													databaseId:
														options.pending.databaseId,
													resourcePath: `/acme/app/pull/7#pullrequestreview-${options.pending.databaseId}`,
												},
											]
										: [],
								},
							},
						},
					},
				});
			}
			if (query.includes("addPullRequestReview(input")) {
				return okJson({
					data: {
						addPullRequestReview: {
							pullRequestReview: {
								id: "REV_NEW",
								databaseId: 11,
								resourcePath: "/acme/app/pull/7#pullrequestreview-11",
							},
						},
					},
				});
			}
			if (query.includes("addPullRequestReviewThread")) {
				if (options.threadError) {
					return okJson({ errors: [{ message: options.threadError }] });
				}
				const lineId = options.lineId ?? 700;
				return okJson({
					data: {
						addPullRequestReviewThread: {
							thread: {
								id: `THREAD_${lineId}`,
								comments: {
									nodes: [
										{
											databaseId: lineId,
											resourcePath: `/acme/app/pull/7#discussion_r${lineId}`,
										},
									],
								},
							},
						},
					},
				});
			}
			if (query.includes("reviewThreads")) {
				if (options.threadsError) {
					return okJson({ errors: [{ message: options.threadsError }] });
				}
				return okJson({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: (options.threads ?? []).map((thread) => ({
										id: thread.id,
										isResolved: thread.isResolved ?? false,
										comments: {
											nodes: [{ databaseId: thread.commentId }],
										},
									})),
								},
							},
						},
					},
				});
			}
			if (query.includes("resolveReviewThread")) {
				if (options.threadsError) {
					return okJson({ errors: [{ message: options.threadsError }] });
				}
				return okJson({
					data: {
						resolveReviewThread: {
							thread: { id: "THREAD", isResolved: true },
						},
					},
				});
			}
			if (query.includes("submitPullRequestReview")) {
				if (options.submitError) {
					return okJson({ errors: [{ message: options.submitError }] });
				}
				return okJson({
					data: {
						submitPullRequestReview: {
							pullRequestReview: {
								id: "REV_NEW",
								databaseId: 11,
								state: "COMMENTED",
							},
						},
					},
				});
			}
			return okJson({ errors: [{ message: "mutation desconhecida" }] });
		}
		if (args[1]?.includes("/issues/")) {
			const generalId = options.generalId ?? 900;
			return okJson({ id: generalId, html_url: `https://x/${generalId}` });
		}
		if (args[0] === "pr" && args[1] === "view") {
			return okJson({
				number: 7,
				url: "https://github.com/acme/app/pull/7",
				headRefOid: "abc",
			});
		}
		if (args.includes("subject_type=file")) {
			if (options.fileError) {
				return { ok: false, code: 422, stderr: "fora do diff", stdout: "" };
			}
			const fileId = options.fileId ?? 800;
			return okJson({ id: fileId, html_url: `https://x/${fileId}` });
		}
		return { ok: false, code: 404, stdout: "", stderr: "chamada não esperada" };
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

	test("filtra pela decisão (a executar vs ainda pendente)", () => {
		const execute = selectSubmitCandidates(state, { decisions: ["execute"] });
		expect(execute.map((c) => c.id)).toEqual(["a"]);
		expect(execute[0].decision).toBe("execute");
		expect(
			selectSubmitCandidates(state, { decisions: ["pending"] }).map((c) => c.id),
		).toEqual(["c"]);
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

	test("renderReviewBody resume as severidades enviadas", () => {
		const candidates = selectSubmitCandidates(
			stateWith([
				finding({ id: "a", severity: "blocking" }),
				finding({ id: "b", severity: "nit" }),
			]),
		);
		const body = renderReviewBody(candidates);
		expect(body).toContain("2 achado");
		expect(body).toContain("blocking");
		expect(body).toContain("nit");
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
	test("cria a revisão e finaliza com COMMENT", () => {
		const state = stateWith([finding({ id: "a", severity: "attention" })]);
		const { runner, calls } = reviewRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.posted).toEqual([
			{
				id: "a",
				kind: "line",
				commentId: 700,
				url: "https://github.com/acme/app/pull/7#discussion_r700",
			},
		]);
		expect(outcome.review).toMatchObject({
			id: 11,
			created: true,
			finalized: true,
			event: "COMMENT",
		});
		expect(state.findings.a.github).toMatchObject({
			commentId: 700,
			kind: "line",
			pr: 7,
			threadId: "THREAD_700",
		});
		expect(calls.filter((args) => args[1] === "graphql")).toHaveLength(4);
	});

	test("cria a revisão e finaliza com REQUEST_CHANGES quando há blocking", () => {
		const state = stateWith([finding({ id: "a", severity: "blocking" })]);
		const { runner } = reviewRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.review?.event).toBe("REQUEST_CHANGES");
		expect(outcome.review?.finalized).toBe(true);
	});

	test("adiciona à revisão pendente existente sem finalizar", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner, calls } = reviewRunner({
			pending: { id: "REV_OLD", databaseId: 42 },
		});
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.review).toMatchObject({
			id: 42,
			created: false,
			finalized: false,
		});
		expect(outcome.posted[0].kind).toBe("line");
		expect(state.findings.a.github?.commentId).toBe(700);

		const submitCall = calls.find((args) =>
			args.some((arg) => arg.includes("submitPullRequestReview")),
		);
		expect(submitCall).toBeUndefined();
		const threadCall = calls.find((args) =>
			args.some((arg) => arg.includes("addPullRequestReviewThread")),
		);
		expect(threadCall).toContain("review=REV_OLD");
	});

	test("linha fora do diff cai no comentário de arquivo", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner } = reviewRunner({ threadError: "line must be part of the diff" });
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.failed).toEqual([]);
		expect(outcome.general).toBeUndefined();
		expect(outcome.posted[0]).toMatchObject({ kind: "file", commentId: 800 });
		expect(state.findings.a.github).toMatchObject({ kind: "file", commentId: 800 });
	});

	test("o que não cola em linha nem arquivo vai para o comentário geral", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner } = reviewRunner({
			threadError: "fora do diff",
			fileError: true,
		});
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.failed).toHaveLength(1);
		expect(outcome.general?.ids).toEqual(["a"]);
		expect(state.findings.a.github?.kind).toBe("comment");
		expect(state.findings.a.github?.commentId).toBe(900);
	});

	test("finding sem linha continua comentário de arquivo, sem revisão", () => {
		const state = stateWith([finding({ id: "a", line: null })]);
		const { runner, calls } = reviewRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.review).toBeUndefined();
		expect(outcome.posted[0]).toMatchObject({ kind: "file", commentId: 800 });
		expect(state.findings.a.github?.kind).toBe("file");
		expect(calls.some((args) => args.includes("subject_type=file"))).toBe(true);
		expect(calls.some((args) => args[1] === "graphql")).toBe(false);
	});

	test("mistura linha na revisão e finding sem linha no arquivo", () => {
		const state = stateWith([finding({ id: "a" }), finding({ id: "c", line: null })]);
		const { runner } = reviewRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.review?.created).toBe(true);
		expect(outcome.posted.map((entry) => entry.kind).sort()).toEqual([
			"file",
			"line",
		]);
		expect(state.findings.c.github?.kind).toBe("file");
	});

	test("pula já enviados (sem chamar o gh)", () => {
		const state = stateWith([finding({ id: "a", commentId: 55 })]);
		const { runner, calls } = reviewRunner();
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(calls).toHaveLength(0);
		expect(outcome.skipped).toHaveLength(1);
		expect(state.findings.a.github?.commentId).toBe(55);
	});

	test("manda path, line e body na thread da revisão", () => {
		const state = stateWith([finding({ id: "a", line: 9 })]);
		const { runner, calls } = reviewRunner({
			pending: { id: "REV_OLD", databaseId: 42 },
		});
		submitFindings({ state, target: TARGET, runner });

		const thread = calls.find((args) =>
			args.some((arg) => arg.includes("addPullRequestReviewThread")),
		);
		expect(thread).toContain("path=src/a.ts");
		expect(thread).toContain("line=9");
		expect(thread).toContain("review=REV_OLD");
		expect(thread?.some((arg) => arg.startsWith("body="))).toBe(true);
	});

	test("falha ao finalizar reporta o erro e mantém o vínculo", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner } = reviewRunner({
			submitError: "review não pode ser submetida",
		});
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.review).toMatchObject({
			created: true,
			finalized: false,
			error: "review não pode ser submetida",
		});
		expect(state.findings.a.github?.commentId).toBe(700);
	});

	test("falha no lookup da revisão não volta a comentários soltos", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner, calls } = reviewRunner({ lookupError: "sem permissão" });
		const outcome = submitFindings({ state, target: TARGET, runner });

		expect(outcome.posted).toEqual([]);
		expect(outcome.general).toBeUndefined();
		expect(outcome.failed).toEqual([{ id: "a", reason: "sem permissão" }]);
		expect(outcome.review).toMatchObject({
			created: false,
			finalized: false,
			error: "sem permissão",
		});
		expect(calls.some((args) => args.includes("subject_type=file"))).toBe(false);
	});
});

describe("resolveFindingThreads", () => {
	const NOW = "2026-02-02T00:00:00.000Z";

	test("resolve a thread aberta e grava threadId/resolvedAt", () => {
		const state = stateWith([finding({ id: "a", commentId: 700 })]);
		const { runner, calls } = reviewRunner({
			threads: [{ id: "THREAD_700", commentId: 700 }],
		});
		const outcome = resolveFindingThreads({
			target: TARGET,
			findings: Object.values(state.findings),
			runner,
			now: NOW,
		});

		expect(outcome.checked).toBe(1);
		expect(outcome.resolved).toEqual([{ id: "a", threadId: "THREAD_700" }]);
		expect(state.findings.a.github).toMatchObject({
			threadId: "THREAD_700",
			resolvedAt: NOW,
		});
		expect(outcome.updated).toEqual(["a"]);
		expect(
			calls.some((args) => args.some((arg) => arg.includes("resolveReviewThread"))),
		).toBe(true);
	});

	test("pula thread já resolvida (sem mutation)", () => {
		const state = stateWith([finding({ id: "a", commentId: 700 })]);
		const { runner, calls } = reviewRunner({
			threads: [{ id: "THREAD_700", commentId: 700, isResolved: true }],
		});
		const outcome = resolveFindingThreads({
			target: TARGET,
			findings: Object.values(state.findings),
			runner,
			now: NOW,
		});

		expect(outcome.resolved).toEqual([]);
		expect(outcome.skipped).toEqual([{ id: "a", reason: "já resolvida no GitHub." }]);
		expect(state.findings.a.github?.resolvedAt).toBe(NOW);
		expect(
			calls.some((args) => args.some((arg) => arg.includes("resolveReviewThread"))),
		).toBe(false);
	});

	test("comentário geral não é thread (não consulta o gh)", () => {
		const state = stateWith([finding({ id: "a", commentId: 900 })]);
		const link = state.findings.a.github;
		if (link) link.kind = "comment";
		const { runner, calls } = reviewRunner();

		const outcome = resolveFindingThreads({
			target: TARGET,
			findings: Object.values(state.findings),
			runner,
		});

		expect(outcome.checked).toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("falha do gh vira failed (fail-open)", () => {
		const state = stateWith([finding({ id: "a", commentId: 700 })]);
		const { runner } = reviewRunner({ threadsError: "sem permissão" });
		const outcome = resolveFindingThreads({
			target: TARGET,
			findings: Object.values(state.findings),
			runner,
		});

		expect(outcome.failed).toEqual([{ id: "a", reason: "sem permissão" }]);
		expect(state.findings.a.github?.resolvedAt).toBeUndefined();
	});

	test("syncResolvedThreads resolve o alvo via gh pr view", () => {
		const state = stateWith([finding({ id: "a", commentId: 700 })]);
		const { runner, calls } = reviewRunner({
			threads: [{ id: "THREAD_700", commentId: 700 }],
		});

		const outcome = syncResolvedThreads({ state, ids: ["a"], runner, now: NOW });

		expect(outcome.available).toBe(true);
		expect(outcome.resolved).toHaveLength(1);
		expect(calls.some((args) => args[0] === "pr" && args[1] === "view")).toBe(true);
	});

	test("syncResolvedThreads sem vínculo remoto não chama o gh", () => {
		const state = stateWith([finding({ id: "a" })]);
		const { runner, calls } = reviewRunner();

		const outcome = syncResolvedThreads({ state, ids: ["a"], runner });

		expect(outcome.checked).toBe(0);
		expect(calls).toHaveLength(0);
	});
});
