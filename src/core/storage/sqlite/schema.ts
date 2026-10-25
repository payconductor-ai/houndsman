/**
 * Schema do banco do houndsman (SQLite).
 *
 * `PRAGMA user_version` versiona o schema; não há migração dos `.runs` antigos
 * (o consumidor é único). Cada tabela tem PK UUID e FKs com cascade.
 */

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS reviews (
	id TEXT PRIMARY KEY,
	repo_key TEXT NOT NULL,
	repo_root TEXT NOT NULL,
	repo_remote TEXT,
	branch TEXT NOT NULL,
	variant TEXT NOT NULL DEFAULT '',
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
	UNIQUE(repo_key, branch, variant)
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
	scenario TEXT,
	impact TEXT,
	confidence REAL,
	basis TEXT,
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
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA synchronous = NORMAL;");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

	const row = db.query("PRAGMA user_version").get() as {
		user_version?: number;
	} | null;
	const version = Number(row?.user_version ?? 0);
	if (version >= SCHEMA_VERSION) {
		db.exec("PRAGMA foreign_keys = ON;");
		return;
	}

	// O rebuild de `reviews` (v5) troca a chave única e precisa de FKs desligadas:
	// com elas ligadas, `DROP TABLE reviews` cascatearia e apagaria os filhos.
	db.exec("PRAGMA foreign_keys = OFF;");
	try {
		db.transaction(() => {
			db.exec(DDL);
			// v2: heartbeat explícito da execução; v3: worktree/pr da revisão;
			// v4: cenário/impacto/confiança/origem do finding.
			const addMissing = (table: string, columns: [string, string][]): void => {
				const info = db.query(`PRAGMA table_info(${table})`).all() as {
					name: string;
				}[];
				for (const [name, type] of columns) {
					if (!info.some((column) => column.name === name)) {
						db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
					}
				}
			};
			addMissing("reviews", [
				["heartbeat_at", "TEXT"],
				["worktree_path", "TEXT"],
				["pr_number", "INTEGER"],
			]);
			addMissing("findings", [
				["scenario", "TEXT"],
				["impact", "TEXT"],
				["confidence", "REAL"],
				["basis", "TEXT"],
			]);
			// v5: variante A/B na identidade da review.
			rebuildReviewsWithVariant(db);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		})();
	} finally {
		db.exec("PRAGMA foreign_keys = ON;");
	}
	const violations = db.query("PRAGMA foreign_key_check").all();
	if (violations.length > 0) {
		throw new Error(
			`Migração do banco deixou ${violations.length} referência(s) inválida(s).`,
		);
	}
}

/**
 * v5 — adiciona `variant` e troca `UNIQUE(repo_key, branch)` por
 * `UNIQUE(repo_key, branch, variant)`.
 *
 * SQLite não remove constraint inline: recria a tabela preservando os ids (as
 * FKs dos filhos continuam válidas) e recria o índice.
 */
function rebuildReviewsWithVariant(db: Database): void {
	const columns = db.query("PRAGMA table_info(reviews)").all() as {
		name: string;
	}[];
	if (columns.some((column) => column.name === "variant")) return;

	db.exec(`
CREATE TABLE reviews_v5 (
	id TEXT PRIMARY KEY,
	repo_key TEXT NOT NULL,
	repo_root TEXT NOT NULL,
	repo_remote TEXT,
	branch TEXT NOT NULL,
	variant TEXT NOT NULL DEFAULT '',
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
	UNIQUE(repo_key, branch, variant)
);
INSERT INTO reviews_v5
	(id, repo_key, repo_root, repo_remote, branch, variant, slug, base, head,
	 head_sha, reviewed_sha, reviewed_at, status, started_at, heartbeat_at,
	 worktree_path, pr_number, created_at, updated_at)
SELECT id, repo_key, repo_root, repo_remote, branch, '', slug, base, head,
	 head_sha, reviewed_sha, reviewed_at, status, started_at, heartbeat_at,
	 worktree_path, pr_number, created_at, updated_at
FROM reviews;
DROP TABLE reviews;
ALTER TABLE reviews_v5 RENAME TO reviews;
CREATE INDEX IF NOT EXISTS idx_reviews_repo_updated
	ON reviews(repo_key, updated_at DESC);
`);
}
