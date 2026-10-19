import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HoundsmanConfig } from "../core/config";
import { buildStateFromFindings, fileReader } from "../core/findings-state";
import { dedupeFindings, parseWatchdogReport } from "../core/report-builder";
import { buildRepoIdentity } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import type { RepoIdentity } from "../core/storage/types";
import { createRequestHandler, startServer } from "../server";
import { isSlug } from "../server/artifacts";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

/** Ambiente fake: banco temporário + review `main` com um finding. */
function makeEnv(): {
	storage: SQLiteStorageProvider;
	repo: RepoIdentity;
	reviewId: string;
	config: HoundsmanConfig;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "houndsman-server-"));
	const storage = new SQLiteStorageProvider(join(dir, "houndsman.db"));
	const repo = buildRepoIdentity(null, dir);
	const review = storage.getOrCreateReview({ repo, branch: "main", slug: "main" });
	const report = parseWatchdogReport(
		{
			watchdogId: "alpha",
			reviewedFiles: ["src/alpha/f.ts"],
			skipped: [],
			findings: [
				{
					rule: "Nunca usar any",
					severity: "blocking",
					file: "src/alpha/f.ts",
					line: 2,
					message: "any detectado",
					action: "tipar",
				},
			],
		},
		"alpha.json",
	);
	if (report) {
		const state = buildStateFromFindings(dedupeFindings([report]), {
			branch: "main",
			readFile: fileReader(process.cwd()),
		});
		// O arquivo fake não existe no cwd → sem âncora. Fixa a linha para o
		// cenário de comentário inline no teste de submit.
		for (const finding of Object.values(state.findings)) finding.line = 2;
		storage.writeFindings(review.id, state);
	}
	storage.writeArtifact(review.id, {
		name: "manifest.json",
		kind: "manifest",
		content: JSON.stringify({ branch: "main" }),
	});
	storage.writeArtifact(review.id, {
		name: "classification.json",
		kind: "classification",
		content: JSON.stringify({ watchdogs: { alpha: ["src/alpha/f.ts"] } }),
	});
	storage.writeArtifact(review.id, {
		name: "review.md",
		kind: "review",
		content: "# Review\n",
	});
	storage.writeArtifact(review.id, {
		name: "briefs/alpha.md",
		kind: "brief",
		content: "# Brief alpha\n",
	});
	return {
		storage,
		repo,
		reviewId: review.id,
		config: fakeHoundsmanConfig,
		cleanup: () => {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const get = (handler: (r: Request) => Promise<Response>, path: string) =>
	handler(new Request(`http://localhost${path}`));

/** Resposta OK do `gh` com um JSON. */
function ghJson(payload: unknown) {
	return { ok: true, code: 0, stderr: "", stdout: JSON.stringify(payload) };
}

describe("server API", () => {
	test("GET /api/runs lista as runs com resumo", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const res = await get(handler, "/api/runs");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				runs: { slug: string; summary: { total: number } }[];
			};
			expect(body.runs).toHaveLength(1);
			expect(body.runs[0].slug).toBe("main");
			expect(body.runs[0].summary.total).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	test("GET findings reconstrói do artefato e PATCH atualiza o estado", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const list = await get(handler, "/api/runs/main/findings?all=1");
			const body = (await list.json()) as {
				findings: { id: string; decision: string }[];
			};
			expect(body.findings).toHaveLength(1);
			const id = body.findings[0].id;
			expect(body.findings[0].decision).toBe("pending");

			const patch = await handler(
				new Request(`http://localhost/api/runs/main/findings/${id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						decision: "execute",
						comment: "trocar por unknown",
					}),
				}),
			);
			expect(patch.status).toBe(200);
			const updated = (await patch.json()) as {
				finding: { decision: string; comment?: string };
			};
			expect(updated.finding.decision).toBe("execute");
			expect(updated.finding.comment).toBe("trocar por unknown");

			const after = (await (
				await get(handler, "/api/runs/main/findings?all=1")
			).json()) as {
				findings: { decision: string }[];
				summary: { byDecision: Record<string, number> };
			};
			expect(after.findings[0].decision).toBe("execute");
			expect(after.summary.byDecision.execute).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	test("PATCH expõe o run status em /api/runs", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const before = (await (await get(handler, "/api/runs")).json()) as {
				runs: { status: string | null }[];
			};
			expect(before.runs[0].status).toBeNull();

			const list = (await (
				await get(handler, "/api/runs/main/findings?all=1")
			).json()) as { findings: { id: string }[] };
			const id = list.findings[0].id;
			await handler(
				new Request(`http://localhost/api/runs/main/findings/${id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ execState: "in_progress" }),
				}),
			);

			const after = (await (await get(handler, "/api/runs")).json()) as {
				runs: { status: string | null }[];
			};
			expect(after.runs[0].status).toBe("fixing");
		} finally {
			env.cleanup();
		}
	});

	test("POST sync devolve o resultado da reancoragem", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			await get(handler, "/api/runs/main/findings?all=1");
			const res = await handler(
				new Request("http://localhost/api/runs/main/sync", { method: "POST" }),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { stale: string[] } };
			expect(Array.isArray(body.result.stale)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	test("GET submit-preview resolve a PR e lista os candidatos", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, {
				storage: env.storage,
				repo: env.repo,
				ghRunner: () => ({
					ok: true,
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 12,
						url: "https://github.com/acme/app/pull/12",
						headRefOid: "deadbeef",
					}),
				}),
			});
			const res = await get(handler, "/api/runs/main/submit-preview");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				available: boolean;
				target: { number: number };
				candidates: { decision: string }[];
			};
			expect(body.available).toBe(true);
			expect(body.target.number).toBe(12);
			expect(body.candidates).toHaveLength(1);
			expect(body.candidates[0].decision).toBe("pending");
		} finally {
			env.cleanup();
		}
	});

	test("POST submit posta comentários e grava o vínculo no estado", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, {
				storage: env.storage,
				repo: env.repo,
				ghRunner: (args) => {
					if (args[0] === "pr") {
						return ghJson({
							number: 12,
							url: "https://github.com/acme/app/pull/12",
							headRefOid: "deadbeef",
						});
					}
					if (args[1] === "graphql") {
						const query = args.find((arg) => arg.startsWith("query=")) ?? "";
						if (query.includes("states: [PENDING]")) {
							return ghJson({
								data: {
									repository: {
										pullRequest: {
											id: "PR_1",
											reviews: { nodes: [] },
										},
									},
								},
							});
						}
						if (query.includes("addPullRequestReview(input")) {
							return ghJson({
								data: {
									addPullRequestReview: {
										pullRequestReview: {
											id: "REV_NEW",
											databaseId: 11,
											resourcePath:
												"/acme/app/pull/12#pullrequestreview-11",
										},
									},
								},
							});
						}
						if (query.includes("addPullRequestReviewThread")) {
							return ghJson({
								data: {
									addPullRequestReviewThread: {
										thread: {
											comments: {
												nodes: [
													{
														databaseId: 501,
														resourcePath:
															"/acme/app/pull/12#discussion_r501",
													},
												],
											},
										},
									},
								},
							});
						}
						if (query.includes("submitPullRequestReview")) {
							return ghJson({
								data: {
									submitPullRequestReview: {
										pullRequestReview: {
											id: "REV_NEW",
											databaseId: 11,
											state: "CHANGES_REQUESTED",
										},
									},
								},
							});
						}
					}
					return { ok: false, code: 404, stderr: "", stdout: "" };
				},
			});
			const res = await handler(
				new Request("http://localhost/api/runs/main/submit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				}),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				available: boolean;
				outcome: { posted: { kind: string }[] };
			};
			expect(body.available).toBe(true);
			expect(body.outcome.posted).toHaveLength(1);
			expect(body.outcome.posted[0].kind).toBe("line");

			const after = (await (
				await get(handler, "/api/runs/main/findings?all=1")
			).json()) as { findings: { github?: { commentId: number } }[] };
			expect(after.findings[0].github?.commentId).toBe(501);
		} finally {
			env.cleanup();
		}
	});

	test("artifacts lista todos os artefatos da run (inclui briefs)", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const res = await get(handler, "/api/runs/main/artifacts");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				artifacts: { name: string; kind: string }[];
			};
			expect(body.artifacts.map((item) => item.name)).toEqual(
				expect.arrayContaining([
					"manifest.json",
					"classification.json",
					"review.md",
					"briefs/alpha.md",
				]),
			);
			expect(
				body.artifacts.find((item) => item.name === "briefs/alpha.md")?.kind,
			).toBe("brief");
		} finally {
			env.cleanup();
		}
	});

	test("artifacts serve arquivos da run e barra o resto", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const ok = await get(handler, "/api/runs/main/artifacts/manifest.json");
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({ branch: "main" });

			const review = await get(handler, "/api/runs/main/artifacts/review.md");
			expect(review.status).toBe(200);
			expect(await review.text()).toContain("# Review");

			const brief = await get(handler, "/api/runs/main/artifacts/briefs/alpha.md");
			expect(brief.status).toBe(200);
			expect(await brief.text()).toContain("# Brief alpha");

			const denied = await get(handler, "/api/runs/main/artifacts/evil.txt");
			expect(denied.status).toBe(404);

			const missingRun = await get(handler, "/api/runs/nao-existe/findings");
			expect(missingRun.status).toBe(404);
		} finally {
			env.cleanup();
		}
	});

	test("valida o slug usado nas rotas", () => {
		expect(isSlug("main")).toBe(true);
		expect(isSlug("feature-x")).toBe(true);
		expect(isSlug("../main")).toBe(false);
		expect(isSlug("a/b")).toBe(false);
	});

	test("GET / serve o shell e /assets/app.js empacota o cliente", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const shell = await get(handler, "/");
			expect(await shell.text()).toContain('id="app"');

			const bundle = await get(handler, "/assets/app.js");
			expect(bundle.status).toBe(200);
			const code = await bundle.text();
			expect(code.length).toBeGreaterThan(100);
			expect(code).toContain("preact");
		} finally {
			env.cleanup();
		}
	});

	test("serve sem cache (no-store) e busta o bundle com um build id", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config, env);
			const shell = await get(handler, "/");
			expect(shell.headers.get("cache-control")).toContain("no-store");
			expect(await shell.text()).toContain("/assets/app.js?v=");

			const bundle = await get(handler, "/assets/app.js");
			expect(bundle.headers.get("cache-control")).toContain("no-store");
		} finally {
			env.cleanup();
		}
	});
});

describe("startServer", () => {
	test("sobe numa porta efêmera e responde ao health check", async () => {
		const env = makeEnv();
		let server: ReturnType<typeof startServer>["server"] | undefined;
		try {
			const started = startServer({
				config: env.config,
				port: 0,
				storage: env.storage,
				repo: env.repo,
			});
			server = started.server;
			const res = await fetch(`${started.url}/api/health`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			server?.stop(true);
			env.cleanup();
		}
	});
});
