/**
 * Schema do banco do houndsman (SQLite).
 *
 * `PRAGMA user_version` versiona o schema; não há migração dos `.runs` antigos
 * (o consumidor é único). Cada tabela tem PK UUID e FKs com cascade.
 */

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS reviews (
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
	heartbeat_at TEXT,
	worktree_path TEXT,
	pr_number INTEGER,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(repo_key, branch)
);

CREATE INDEX IF NOT EXISTS idx_reviews_repo_updated
	ON reviews(repo_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS findings (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
	short_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	watchdog_ids TEXT NOT NULL,
	rule TEXT NOT NULL,
	severity TEXT NOT NULL,
	file TEXT NOT NULL,
	line INTEGER,
	message TEXT NOT NULL,
	action TEXT NOT NULL,
	evidence TEXT,
	anchor TEXT,
	found_at_sha TEXT,
	count INTEGER NOT NULL DEFAULT 1,
	present INTEGER NOT NULL DEFAULT 1,
	decision TEXT NOT NULL,
	comment TEXT,
	exec_state TEXT NOT NULL,
	github TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(review_id, short_id),
	UNIQUE(review_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);

CREATE TABLE IF NOT EXISTS finding_history (
	id TEXT PRIMARY KEY,
	finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
	at TEXT NOT NULL,
	decision TEXT NOT NULL,
	exec_state TEXT NOT NULL,
	comment TEXT,
	by TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_finding ON finding_history(finding_id);

CREATE TABLE IF NOT EXISTS artifacts (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	content TEXT NOT NULL,
	content_type TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(review_id, name)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_review ON artifacts(review_id);
`;

/** Aplica pragmas e cria o schema quando necessário. */
export function migrate(db: Database, path: string): void {
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA synchronous = NORMAL;");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

	const row = db.query("PRAGMA user_version").get() as {
		user_version?: number;
	} | null;
	const version = Number(row?.user_version ?? 0);
	if (version >= SCHEMA_VERSION) return;

	db.transaction(() => {
		db.exec(DDL);
		// v2: heartbeat explícito da execução (bancos v1 não tinham a coluna).
		// v3: worktree/pr da revisão (revisões paralelas).
		const columns = db.query("PRAGMA table_info(reviews)").all() as {
			name: string;
		}[];
		const missing: [string, string][] = [
			["heartbeat_at", "TEXT"],
			["worktree_path", "TEXT"],
			["pr_number", "INTEGER"],
		];
		for (const [name, type] of missing) {
			if (!columns.some((column) => column.name === name)) {
				db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${type}`);
			}
		}
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}
