import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HoundsmanConfig } from "../core/config";
import { createRequestHandler, startServer } from "../server";
import { readRunFile, runDirForSlug } from "../server/artifacts";
import { fakeHoundsmanConfig } from "./fixtures/fake-project";

/** Run fake em disco + config apontando para ela. */
function makeEnv(): {
	artifactDir: string;
	config: HoundsmanConfig;
	cleanup: () => void;
} {
	const artifactDir = mkdtempSync(join(tmpdir(), "houndsman-server-"));
	const outDir = join(artifactDir, "main");
	mkdirSync(join(outDir, "findings"), { recursive: true });
	writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ branch: "main" }));
	writeFileSync(
		join(outDir, "classification.json"),
		JSON.stringify({ watchdogs: { alpha: ["src/alpha/f.ts"] } }),
	);
	writeFileSync(join(outDir, "review.md"), "# Review\n");
	writeFileSync(
		join(outDir, "findings", "alpha.json"),
		JSON.stringify({
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
		}),
	);
	return {
		artifactDir,
		config: { ...fakeHoundsmanConfig, artifactDir },
		cleanup: () => rmSync(artifactDir, { recursive: true, force: true }),
	};
}

/** Semeia um `state.json` com um finding inline (tem linha) na run. */
function seedState(artifactDir: string, branch: string): void {
	writeFileSync(
		join(artifactDir, branch, "state.json"),
		JSON.stringify({
			version: 2,
			branch,
			slug: branch,
			updatedAt: "2026-01-01T00:00:00.000Z",
			order: ["f1"],
			findings: {
				f1: {
					id: "f1",
					fingerprint: "fp1",
					watchdogIds: ["alpha"],
					rule: "Nunca usar any",
					severity: "blocking",
					file: "src/alpha/f.ts",
					line: 2,
					message: "any detectado",
					action: "tipar",
					anchor: null,
					count: 1,
					present: true,
					decision: "pending",
					execState: "pending",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					history: [],
				},
			},
		}),
	);
}

const get = (handler: (r: Request) => Promise<Response>, path: string) =>
	handler(new Request(`http://localhost${path}`));

describe("server API", () => {
	test("GET /api/runs lista as runs com resumo", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config);
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
			const handler = createRequestHandler(env.config);
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
			const handler = createRequestHandler(env.config);
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
			const handler = createRequestHandler(env.config);
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
				candidates: unknown[];
			};
			expect(body.available).toBe(true);
			expect(body.target.number).toBe(12);
			expect(body.candidates).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	test("POST submit posta comentários e grava o vínculo no estado", async () => {
		const env = makeEnv();
		try {
			seedState(env.artifactDir, "main");
			const handler = createRequestHandler(env.config, {
				ghRunner: (args) =>
					args[0] === "pr"
						? {
								ok: true,
								code: 0,
								stderr: "",
								stdout: JSON.stringify({
									number: 12,
									url: "https://github.com/acme/app/pull/12",
									headRefOid: "deadbeef",
								}),
							}
						: {
								ok: true,
								code: 0,
								stderr: "",
								stdout: JSON.stringify({
									id: 501,
									html_url: "https://x/501",
								}),
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
			expect(body.outcome.posted[0].kind).toBe("inline");

			const after = (await (
				await get(handler, "/api/runs/main/findings?all=1")
			).json()) as { findings: { github?: { commentId: number } }[] };
			expect(after.findings[0].github?.commentId).toBe(501);
		} finally {
			env.cleanup();
		}
	});

	test("artifacts serve arquivos da run e barra o resto", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config);
			const ok = await get(handler, "/api/runs/main/artifacts/manifest.json");
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({ branch: "main" });

			const review = await get(handler, "/api/runs/main/artifacts/review.md");
			expect(review.status).toBe(200);
			expect(await review.text()).toContain("# Review");

			const denied = await get(handler, "/api/runs/main/artifacts/evil.txt");
			expect(denied.status).toBe(404);

			const missingRun = await get(handler, "/api/runs/nao-existe/findings");
			expect(missingRun.status).toBe(404);
		} finally {
			env.cleanup();
		}
	});

	test("readRunFile barra path traversal", () => {
		const env = makeEnv();
		try {
			const dir = runDirForSlug(env.artifactDir, "main");
			expect(dir).not.toBeNull();
			expect(readRunFile(dir as string, "../../../etc/passwd")).toBeNull();
			expect(readRunFile(dir as string, "manifest.json")).toContain("main");
			expect(runDirForSlug(env.artifactDir, "../main")).toBeNull();
		} finally {
			env.cleanup();
		}
	});

	test("GET / serve o shell e /assets/app.js empacota o cliente", async () => {
		const env = makeEnv();
		try {
			const handler = createRequestHandler(env.config);
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
			const handler = createRequestHandler(env.config);
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
			const started = startServer({ config: env.config, port: 0 });
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
