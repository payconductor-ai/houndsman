/**
 * Contrato do storage — SQLite (default) e arquivos (fallback).
 *
 * Garante que trocar `storage.provider` não muda o comportamento observável:
 * reviews, findings (com histórico/âncora/github) e artefatos.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FindingState,
	type FindingsStateFile,
	reorder,
	resolveFindingId,
} from "../core/findings-state";
import { FileStorageProvider } from "../core/storage/file/file-storage";
import { buildRepoIdentity, normalizeRemote } from "../core/storage/repo-identity";
import { SQLiteStorageProvider } from "../core/storage/sqlite/sqlite-storage";
import type { StorageProvider } from "../core/storage/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function finding(id: string, partial: Partial<FindingState> = {}): FindingState {
	return {
		id,
		fingerprint: `fp-${id}`,
		watchdogIds: ["alpha"],
		rule: "regra",
		severity: "attention",
		file: "src/a.ts",
		line: 3,
		message: "msg",
		action: "ação",
		evidence: "const a = 1;",
		anchor: { snippet: "const a = 1;", line: 3 },
		foundAtSha: "abc123",
		count: 2,
		present: true,
		decision: "execute",
		comment: "fazer",
		execState: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		history: [
			{
				at: "2026-01-01T00:00:00.000Z",
				decision: "pending",
				execState: "pending",
			},
			{
				at: "2026-01-01T00:05:00.000Z",
				decision: "execute",
				execState: "pending",
				comment: "fazer",
				by: "humano",
			},
		],
		github: {
			commentId: 501,
			url: "https://x/501",
			kind: "line",
			pr: 12,
			at: "2026-01-01T00:10:00.000Z",
		},
		...partial,
	};
}

function sampleState(branch = "feature/x"): FindingsStateFile {
	const state: FindingsStateFile = {
		version: 2,
		branch,
		slug: "feature-x",
		updatedAt: "2026-01-02T00:00:00.000Z",
		order: [],
		reviewed: { headSha: "deadbeef", at: "2026-01-02T00:00:00.000Z" },
		findings: {
			ab12cd34ef: finding("ab12cd34ef"),
			ff00aa11bb: finding("ff00aa11bb", {
				fingerprint: "fp-2",
				file: "src/b.ts",
				severity: "nit",
				history: [],
			}),
		},
	};
	reorder(state);
	return state;
}

/** Executa o mesmo contrato para qualquer provider. */
function contract(
	name: string,
	make: () => { storage: StorageProvider; cleanup: () => void },
): void {
	describe(`storage — ${name}`, () => {
		test("reviews: get-or-create idempotente, update e listagem por repo", () => {
			const { storage, cleanup } = make();
			try {
				const repo = buildRepoIdentity("git@github.com:acme/app.git", "/tmp/app");
				const first = storage.getOrCreateReview({
					repo,
					branch: "feature/x",
					slug: "feature-x",
				});
				expect(first.id).toMatch(UUID);
				const again = storage.getOrCreateReview({
					repo,
					branch: "feature/x",
					slug: "feature-x",
				});
				expect(again.id).toBe(first.id);
				expect(storage.findReview(repo.key, "feature/x")?.id).toBe(first.id);

				storage.updateReview(first.id, {
					status: "reviewing",
					resetStartedAt: true,
					updatedAt: "2026-01-01T00:00:00.000Z",
				});
				storage.updateReview(first.id, {
					status: "review_done",
					updatedAt: "2026-01-01T00:10:00.000Z",
				});
				const updated = storage.getReview(first.id);
				expect(updated?.status).toBe("review_done");
				expect(updated?.startedAt).toBe("2026-01-01T00:00:00.000Z");
				expect(updated?.updatedAt).toBe("2026-01-01T00:10:00.000Z");

				// Outro repo não aparece no escopo.
				storage.getOrCreateReview({
					repo: buildRepoIdentity(null, "/tmp/other"),
					branch: "main",
					slug: "main",
				});
				expect(storage.listReviews(repo.key)).toHaveLength(1);
				expect(storage.listReviews()).toHaveLength(2);
			} finally {
				cleanup();
			}
		});

		test("findings: round-trip completo e preservação do short id", () => {
			const { storage, cleanup } = make();
			try {
				const repo = buildRepoIdentity(null, "/tmp/app");
				const review = storage.getOrCreateReview({
					repo,
					branch: "feature/x",
					slug: "feature-x",
				});
				const state = sampleState();
				storage.writeFindings(review.id, state);

				const read = storage.readFindings(review.id);
				expect(read?.branch).toBe("feature/x");
				expect(read?.reviewed).toEqual(state.reviewed);
				expect(Object.keys(read?.findings ?? {}).sort()).toEqual([
					"ab12cd34ef",
					"ff00aa11bb",
				]);
				const one = read?.findings.ab12cd34ef;
				expect(one?.fingerprint).toBe("fp-ab12cd34ef");
				expect(one?.anchor).toEqual(state.findings.ab12cd34ef.anchor);
				expect(one?.foundAtSha).toBe("abc123");
				expect(one?.github?.commentId).toBe(501);
				expect(one?.history).toHaveLength(2);
				expect(storage.getReview(review.id)?.reviewedSha).toBe("deadbeef");

				// Atualização: preserva id e troca o histórico.
				if (read) {
					read.findings.ab12cd34ef.execState = "done";
					read.findings.ab12cd34ef.history = [];
					read.updatedAt = "2026-01-03T00:00:00.000Z";
					storage.writeFindings(review.id, read);
				}
				const after = storage.readFindings(review.id);
				expect(after?.findings.ab12cd34ef.id).toBe("ab12cd34ef");
				expect(after?.findings.ab12cd34ef.execState).toBe("done");
				expect(after?.findings.ab12cd34ef.history).toHaveLength(0);
			} finally {
				cleanup();
			}
		});

		test("artefatos: upsert, listagem e remoção", () => {
			const { storage, cleanup } = make();
			try {
				const repo = buildRepoIdentity(null, "/tmp/app");
				const review = storage.getOrCreateReview({
					repo,
					branch: "main",
					slug: "main",
				});
				const first = storage.writeArtifact(review.id, {
					name: "review.md",
					kind: "review",
					content: "# Review\n",
				});
				expect(first.id).toMatch(UUID);
				const second = storage.writeArtifact(review.id, {
					name: "review.md",
					kind: "review",
					content: "# Review 2\n",
				});
				expect(second.id).toBe(first.id);
				expect(storage.readArtifact(review.id, "review.md")?.content).toBe(
					"# Review 2\n",
				);
				storage.writeArtifact(review.id, {
					name: "manifest.json",
					kind: "manifest",
					content: "{}",
				});
				expect(storage.listArtifacts(review.id).map((item) => item.name)).toEqual(
					["manifest.json", "review.md"],
				);
				storage.deleteArtifact(review.id, "manifest.json");
				expect(storage.listArtifacts(review.id)).toHaveLength(1);
			} finally {
				cleanup();
			}
		});

		test("delete da review remove findings e artefatos (cascade)", () => {
			const { storage, cleanup } = make();
			try {
				const repo = buildRepoIdentity(null, "/tmp/app");
				const review = storage.getOrCreateReview({
					repo,
					branch: "main",
					slug: "main",
				});
				storage.writeFindings(review.id, sampleState("main"));
				storage.writeArtifact(review.id, {
					name: "review.md",
					kind: "review",
					content: "# Review\n",
				});
				storage.deleteReview(review.id);
				expect(storage.getReview(review.id)).toBeNull();
				expect(storage.readFindings(review.id)).toBeNull();
				expect(storage.readArtifact(review.id, "review.md")).toBeNull();
			} finally {
				cleanup();
			}
		});

		test("maintain e location não quebram", () => {
			const { storage, cleanup } = make();
			try {
				const repo = buildRepoIdentity(null, "/tmp/app");
				const review = storage.getOrCreateReview({
					repo,
					branch: "main",
					slug: "main",
				});
				expect(() => storage.maintain()).not.toThrow();
				expect(storage.location(review.id)).toContain(review.id);
			} finally {
				cleanup();
			}
		});
	});
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "houndsman-storage-"));
}

contract("sqlite", () => {
	const dir = tempDir();
	const storage = new SQLiteStorageProvider(join(dir, "houndsman.db"));
	return {
		storage,
		cleanup: () => {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
});

contract("file", () => {
	const dir = tempDir();
	const storage = new FileStorageProvider(join(dir, "runs"));
	return {
		storage,
		cleanup: () => {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
});

describe("storage — detalhes do SQLite", () => {
	test("findings usam UUID como PK e short id como identidade de exibição", () => {
		const dir = tempDir();
		const path = join(dir, "houndsman.db");
		const storage = new SQLiteStorageProvider(path);
		try {
			const repo = buildRepoIdentity(null, "/tmp/app");
			const review = storage.getOrCreateReview({
				repo,
				branch: "main",
				slug: "main",
			});
			storage.writeFindings(review.id, sampleState("main"));

			const db = new Database(path, { readonly: true });
			try {
				const rows = db.query("SELECT id, short_id FROM findings").all() as {
					id: string;
					short_id: string;
				}[];
				expect(rows).toHaveLength(2);
				for (const row of rows) {
					expect(row.id).toMatch(UUID);
					expect(row.short_id).toMatch(/^[0-9a-f]{10}$/);
					expect(row.id).not.toBe(row.short_id);
				}
			} finally {
				db.close();
			}
		} finally {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("repo identity", () => {
	test("normaliza remotes HTTPS, SSH e SCP", () => {
		expect(normalizeRemote("https://github.com/Acme/App.git")).toBe(
			"github.com/Acme/App",
		);
		expect(normalizeRemote("ssh://git@gitlab.com/group/repo.git")).toBe(
			"gitlab.com/group/repo",
		);
		expect(normalizeRemote("git@github.com:acme/app.git")).toBe(
			"github.com/acme/app",
		);
		expect(normalizeRemote("/tmp/local")).toBeNull();
	});

	test("usa remote como key e cai na raiz quando ausente", () => {
		const withRemote = buildRepoIdentity("git@github.com:acme/app.git", "/tmp/app");
		expect(withRemote.key).toBe("remote:github.com/acme/app");
		const local = buildRepoIdentity(null, "/tmp/app");
		expect(local.key.startsWith("path:")).toBe(true);
		expect(local.key.endsWith("/tmp/app")).toBe(true);
	});
});

describe("resolveFindingId", () => {
	const state = sampleState();
	test("exato vence, prefixo único resolve e ambíguo lista candidatos", () => {
		expect(resolveFindingId(state, "ab12cd34ef")).toEqual({
			status: "found",
			id: "ab12cd34ef",
		});
		expect(resolveFindingId(state, "ab12")).toEqual({
			status: "found",
			id: "ab12cd34ef",
		});
		expect(resolveFindingId(state, "ff00")).toEqual({
			status: "found",
			id: "ff00aa11bb",
		});
		expect(resolveFindingId(state, "zzz")).toEqual({ status: "missing" });
	});

	test("prefixo compartilhado é ambíguo", () => {
		const clash = sampleState();
		clash.findings = {
			abcd000001: { ...clash.findings.ab12cd34ef, id: "abcd000001" },
			abcd000002: { ...clash.findings.ff00aa11bb, id: "abcd000002" },
		};
		reorder(clash);
		expect(resolveFindingId(clash, "abcd")).toEqual({
			status: "ambiguous",
			matches: ["abcd000001", "abcd000002"],
		});
	});
});

describe("migração do schema SQLite", () => {
	test("banco v1 ganha a coluna heartbeat_at sem perder reviews", () => {
		const dir = mkdtempSync(join(tmpdir(), "houndsman-migrate-"));
		const path = join(dir, "houndsman.db");
		const legacy = new Database(path);
		try {
			legacy.exec(`
				CREATE TABLE reviews (
					id TEXT PRIMARY KEY,
					repo_key TEXT NOT NULL,
					repo_root TEXT NOT NULL,
					repo_remote TEXT,
					branch TEXT NOT NULL,
					slug TEXT NOT NULL,
					base TEXT,
					head TEXT,
					head_sha TEXT,
					reviewed_sha TEXT,
					reviewed_at TEXT,
					status TEXT,
					started_at TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE(repo_key, branch)
				);
				PRAGMA user_version = 1;
			`);
			legacy.run(
				`INSERT INTO reviews
					(id, repo_key, repo_root, branch, slug, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"11111111-1111-4111-8111-111111111111",
					"path:/repo",
					dir,
					"feature/x",
					"feature-x",
					"reviewing",
					"2026-01-01T00:00:00.000Z",
					"2026-01-01T00:00:00.000Z",
				],
			);
		} finally {
			legacy.close();
		}

		const storage = new SQLiteStorageProvider(path);
		try {
			const review = storage.listReviews()[0];
			expect(review?.heartbeatAt).toBeUndefined();
			storage.updateReview(review.id, {
				heartbeatAt: "2026-01-01T00:05:00.000Z",
			});
			expect(storage.getReview(review.id)?.heartbeatAt).toBe(
				"2026-01-01T00:05:00.000Z",
			);
		} finally {
			storage.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
