/**
 * Estado de triagem dos findings (biblioteca).
 *
 * Persistido em `.houndsman/.runs/<slug>/state.json` (local — coberto pelo
 * `.gitignore` gerado, que ignora `.runs/`). Cada finding tem um `id` curto e um
 * `fingerprint` de conteúdo: nas re-execuções do `--finalize` o estado é
 * preservado casando por fingerprint.
 *
 * A `line` é cache — `syncState` a recalcula após edições (auto-fix) e marca
 * `stale` quando a âncora some.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	buildAnchor,
	type FindingAnchor,
	fingerprintOf,
	locateAnchor,
	reanchor,
} from "./finding-anchor";
import { STATE_FILE } from "./paths";
import {
	dedupeFindings,
	type MergedFinding,
	parseWatchdogReport,
	sanitizeBranch,
	type WatchdogReport,
} from "./report-builder";
import { SEVERITY_ORDER, type Severity, severityRank } from "./types";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Decisão de triagem: o que fazer com o finding. */
export type FindingDecision = "pending" | "execute" | "ignore";

/** Estado de execução: em que pé está a ação. */
export type FindingExecState = "pending" | "in_progress" | "done" | "stale";

/** Valores canônicos (na ordem de exibição). */
export const FINDING_DECISIONS: readonly FindingDecision[] = [
	"pending",
	"execute",
	"ignore",
];

/** Valores canônicos de `execState`. */
export const FINDING_EXEC_STATES: readonly FindingExecState[] = [
	"pending",
	"in_progress",
	"done",
	"stale",
];

const DECISION_SET = new Set<string>(FINDING_DECISIONS);
const EXEC_SET = new Set<string>(FINDING_EXEC_STATES);

/** Entrada de auditoria (quem mudou o quê). */
export type FindingHistoryEntry = {
	at: string;
	decision: FindingDecision;
	execState: FindingExecState;
	comment?: string;
	by?: string;
};

/** Marco da revisão que originou o estado: commit revisado + quando. */
export type FindingsReviewed = {
	/** SHA do commit revisado (head do diff no `--finalize`). */
	headSha: string;
	at: string;
};

/** Um finding triável, com o estado das duas dimensões. */
export type FindingState = {
	id: string;
	fingerprint: string;
	watchdogIds: string[];
	rule: string;
	severity: Severity;
	file: string;
	line: number | null;
	message: string;
	action: string;
	evidence?: string;
	anchor: FindingAnchor | null;
	/** Commit em que o achado foi observado (base do diff focado do verify). */
	foundAtSha?: string;
	/** Ocorrências idênticas colapsadas neste fingerprint (>1 = grupo). */
	count: number;
	/** Ainda presente no último relatório consolidado. */
	present: boolean;
	decision: FindingDecision;
	comment?: string;
	execState: FindingExecState;
	createdAt: string;
	updatedAt: string;
	history: FindingHistoryEntry[];
};

/** Conteúdo do `state.json`. */
export type FindingsStateFile = {
	version: 2;
	branch: string;
	slug: string;
	updatedAt: string;
	/** Ids na ordem de exibição (estável). */
	order: string[];
	/** Commit revisado — habilita o review incremental e o verify por diff. */
	reviewed?: FindingsReviewed;
	findings: Record<string, FindingState>;
};

export const FINDINGS_STATE_VERSION = 2;

// ---------------------------------------------------------------------------
// Caminhos
// ---------------------------------------------------------------------------

/** Diretório de artefatos da run (branch-slug). */
export function runDir(artifactDir: string, branch: string): string {
	return join(artifactDir, sanitizeBranch(branch));
}

/** Caminho do `state.json` da run. */
export function stateFile(artifactDir: string, branch: string): string {
	return join(runDir(artifactDir, branch), STATE_FILE);
}

/** Leitor de arquivos relativos à raiz do projeto (injetável nos testes). */
export type FileReader = (relativePath: string) => string | null;

/** Leitor padrão a partir do cwd (null se ausente/ilegível). */
export function fileReader(cwd: string): FileReader {
	return (relativePath: string) => {
		try {
			const full = join(cwd, relativePath);
			return existsSync(full) ? readFileSync(full, "utf8") : null;
		} catch {
			return null;
		}
	};
}

/** Id curto aleatório (hex) para um finding novo. */
export function newFindingId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 10);
}

/** Estado vazio para uma branch. */
export function emptyState(branch: string): FindingsStateFile {
	return {
		version: FINDINGS_STATE_VERSION,
		branch,
		slug: sanitizeBranch(branch),
		updatedAt: new Date().toISOString(),
		order: [],
		findings: {},
	};
}

// ---------------------------------------------------------------------------
// Ordenação / resumo
// ---------------------------------------------------------------------------

/** Presentes primeiro; depois severidade, arquivo e linha. */
export function compareFindings(a: FindingState, b: FindingState): number {
	if (a.present !== b.present) return a.present ? -1 : 1;
	const bySeverity = severityRank(a.severity) - severityRank(b.severity);
	if (bySeverity !== 0) return bySeverity;
	if (a.file !== b.file) return a.file.localeCompare(b.file);
	return (a.line ?? 0) - (b.line ?? 0);
}

/** Ordena os ids do estado (recomputa `order`). */
export function reorder(state: FindingsStateFile): void {
	state.order = Object.values(state.findings)
		.sort(compareFindings)
		.map((f) => f.id);
}

export type FindingsSummary = {
	total: number;
	present: number;
	byDecision: Record<FindingDecision, number>;
	byExecState: Record<FindingExecState, number>;
	bySeverity: Record<Severity, number>;
};

/** Contagens por decisão, execução e severidade. */
export function summarize(state: FindingsStateFile): FindingsSummary {
	const byDecision = Object.fromEntries(FINDING_DECISIONS.map((d) => [d, 0])) as Record<
		FindingDecision,
		number
	>;
	const byExecState = Object.fromEntries(
		FINDING_EXEC_STATES.map((e) => [e, 0]),
	) as Record<FindingExecState, number>;
	const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<
		Severity,
		number
	>;

	let total = 0;
	let present = 0;
	for (const finding of Object.values(state.findings)) {
		total++;
		if (finding.present) present++;
		byDecision[finding.decision]++;
		byExecState[finding.execState]++;
		bySeverity[finding.severity]++;
	}
	return { total, present, byDecision, byExecState, bySeverity };
}

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

export type FindingsFilter = {
	decision?: FindingDecision;
	execState?: FindingExecState;
	watchdog?: string;
	severity?: Severity;
	/** Substring do caminho (case-insensitive). */
	file?: string;
	/** Inclui findings ausentes do último relatório (default: só presentes). */
	includeAbsent?: boolean;
};

/** Aplica o filtro e devolve os findings ordenados. */
export function filterFindings(
	state: FindingsStateFile,
	filter: FindingsFilter = {},
): FindingState[] {
	const needle = filter.file?.toLowerCase();
	return Object.values(state.findings)
		.filter((finding) => {
			if (!filter.includeAbsent && !finding.present) return false;
			if (filter.decision && finding.decision !== filter.decision) return false;
			if (filter.execState && finding.execState !== filter.execState) return false;
			if (filter.severity && finding.severity !== filter.severity) return false;
			if (filter.watchdog && !finding.watchdogIds.includes(filter.watchdog)) {
				return false;
			}
			if (needle && !finding.file.toLowerCase().includes(needle)) return false;
			return true;
		})
		.sort(compareFindings);
}

// ---------------------------------------------------------------------------
// Construção (finalize)
// ---------------------------------------------------------------------------

export type BuildStateOptions = {
	branch: string;
	readFile: FileReader;
	previous?: FindingsStateFile | null;
	/** Commit revisado — carimbado nos findings e no `reviewed` do estado. */
	reviewed?: FindingsReviewed;
	/** SHA usado para carimbar `foundAtSha` de findings novos/re-reportados. */
	headSha?: string;
	now?: string;
};

/**
 * Constrói o estado a partir dos findings consolidados, preservando o que já
 * existia (casando por `fingerprint`). Depende de ler o arquivo para ancorar;
 * sem conteúdo (deletado/binário) a âncora fica nula e o fingerprint cai no
 * `message`.
 *
 * Muta cada `finding` recebido com o `id` correspondente (para o relatório).
 */
export function buildStateFromFindings(
	merged: readonly MergedFinding[],
	options: BuildStateOptions,
): FindingsStateFile {
	const now = options.now ?? new Date().toISOString();
	const previous = options.previous ?? null;

	const result: Record<string, FindingState> = {};
	// 1. Preserva o estado anterior (marca como ausente até provar o contrário).
	for (const prev of Object.values(previous?.findings ?? {})) {
		result[prev.id] = {
			...prev,
			present: false,
			execState:
				prev.execState === "pending" && prev.decision === "execute"
					? "done"
					: prev.execState,
			updatedAt: now,
		};
	}

	// 2. Findings atuais, agrupados por fingerprint.
	const byFingerprint = new Map<string, FindingState>();
	for (const finding of merged) {
		const content = options.readFile(finding.file);
		const anchor = content
			? buildAnchor(content, finding.line, finding.evidence)
			: null;
		const fingerprint = fingerprintOf(
			finding.file,
			finding.rule,
			anchor,
			finding.message,
		);

		const group = byFingerprint.get(fingerprint);
		if (group) {
			group.count++;
			for (const w of finding.watchdogs) {
				if (!group.watchdogIds.includes(w)) group.watchdogIds.push(w);
			}
			finding.id = group.id;
			continue;
		}

		const prev = previous
			? Object.values(previous.findings).find((f) => f.fingerprint === fingerprint)
			: undefined;
		const created: FindingState = {
			id: prev?.id ?? newFindingId(),
			fingerprint,
			watchdogIds: [...finding.watchdogs],
			rule: finding.rule,
			severity: finding.severity,
			file: finding.file,
			line: anchor ? anchor.line : null,
			message: finding.message,
			action: finding.action,
			evidence: finding.evidence,
			anchor,
			// Carry-over preserva o `foundAtSha` original; novos/re-reportados usam o head atual.
			foundAtSha: finding.foundAtSha ?? options.headSha ?? prev?.foundAtSha,
			count: 1,
			present: true,
			decision: prev?.decision ?? "pending",
			comment: prev?.comment,
			execState: prev?.execState ?? "pending",
			createdAt: prev?.createdAt ?? now,
			updatedAt: now,
			history: prev?.history ?? [],
		};
		byFingerprint.set(fingerprint, created);
		result[created.id] = created;
		finding.id = created.id;
	}

	const state: FindingsStateFile = {
		version: FINDINGS_STATE_VERSION,
		branch: options.branch,
		slug: sanitizeBranch(options.branch),
		updatedAt: now,
		order: [],
		reviewed: options.reviewed ?? previous?.reviewed,
		findings: result,
	};
	reorder(state);
	return state;
}

/**
 * Reconstrói o estado a partir dos artefatos da run (`classification.json` +
 * `findings/<id>.json`), sem exigir `--finalize`. Devolve null se não houver
 * findings gravados.
 */
export function buildStateFromRunDir(
	outDir: string,
	branch: string,
	readFile: FileReader,
): FindingsStateFile | null {
	const classificationPath = join(outDir, "classification.json");
	if (!existsSync(classificationPath)) return null;

	let activeIds: string[] = [];
	try {
		const classification = JSON.parse(readFileSync(classificationPath, "utf8")) as {
			watchdogs?: Record<string, string[]>;
		};
		activeIds = Object.keys(classification.watchdogs ?? {});
	} catch {
		return null;
	}

	const reports: WatchdogReport[] = [];
	for (const id of activeIds) {
		const path = join(outDir, "findings", `${id}.json`);
		if (!existsSync(path)) continue;
		try {
			const report = parseWatchdogReport(
				JSON.parse(readFileSync(path, "utf8")),
				path,
			);
			if (report) reports.push(report);
		} catch {
			// Ignora findings ilegíveis — reconstrução best-effort.
		}
	}
	if (reports.length === 0) return null;

	return buildStateFromFindings(dedupeFindings(reports), { branch, readFile });
}
// ---------------------------------------------------------------------------

export type FindingUpdate = {
	decision?: FindingDecision;
	comment?: string;
	execState?: FindingExecState;
	by?: string;
};

/** Aplica uma atualização a um finding (registrando histórico). */
export function applyFindingUpdate(
	finding: FindingState,
	update: FindingUpdate,
	now: string = new Date().toISOString(),
): FindingState {
	if (update.decision && DECISION_SET.has(update.decision)) {
		finding.decision = update.decision;
	}
	if (update.execState && EXEC_SET.has(update.execState)) {
		finding.execState = update.execState;
	}
	if (update.comment !== undefined) finding.comment = update.comment;
	finding.updatedAt = now;
	finding.history.push({
		at: now,
		decision: finding.decision,
		execState: finding.execState,
		comment: finding.comment,
		by: update.by,
	});
	return finding;
}

export type SyncResult = {
	ok: number;
	moved: string[];
	stale: string[];
};

/**
 * Reancora todos os findings presentes lendo os arquivos atuais. Findings cuja
 * âncora sumiu viram `stale` (ou `done` se a decisão era `execute`).
 * Muta o estado em memória (o caller persiste).
 */
export function syncState(
	state: FindingsStateFile,
	readFile: FileReader,
	now: string = new Date().toISOString(),
): SyncResult {
	const moved: string[] = [];
	const stale: string[] = [];
	let ok = 0;

	for (const finding of Object.values(state.findings)) {
		if (!finding.present) continue;
		const content = readFile(finding.file);
		if (content === null) {
			if (finding.execState !== "done") finding.execState = "stale";
			finding.updatedAt = now;
			stale.push(finding.id);
			continue;
		}
		const { status, line } = reanchor(content, finding.anchor, finding.line);
		if (status === "stale") {
			finding.execState =
				finding.decision === "execute" && finding.execState === "pending"
					? "done"
					: finding.execState === "done"
						? "done"
						: "stale";
			finding.updatedAt = now;
			stale.push(finding.id);
			continue;
		}
		if (status === "moved" && line !== null) {
			finding.line = line;
			if (finding.anchor) finding.anchor.line = line;
			finding.updatedAt = now;
			moved.push(finding.id);
			continue;
		}
		ok++;
	}

	if (moved.length > 0 || stale.length > 0) state.updatedAt = now;
	return { ok, moved, stale };
}

/** Nº de ocorrências da âncora na versão atual do arquivo (diagnóstico). */
export function occurrenceCount(
	fileContent: string,
	anchor: FindingAnchor | null,
): number {
	return locateAnchor(fileContent, anchor).occurrences;
}

// ---------------------------------------------------------------------------
// Store (I/O atômico)
// ---------------------------------------------------------------------------

/** Persistência do `state.json` — escrita atômica (tmp + rename). */
export class FindingsStateStore {
	private readonly path: string;
	private readonly branch: string;

	constructor(path: string, branch: string) {
		this.path = path;
		this.branch = branch;
	}

	/** Store para a run de uma branch. */
	static at(artifactDir: string, branch: string): FindingsStateStore {
		return new FindingsStateStore(stateFile(artifactDir, branch), branch);
	}

	get filePath(): string {
		return this.path;
	}

	/** Lê o estado; null se ausente/inválido. */
	read(): FindingsStateFile | null {
		if (!existsSync(this.path)) return null;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as FindingsStateFile;
			if (raw?.version !== FINDINGS_STATE_VERSION || !raw.findings) return null;
			return raw;
		} catch {
			return null;
		}
	}

	/** Grava o estado de forma atômica. */
	write(state: FindingsStateFile): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(tmp, this.path);
	}

	/** Lê-modifica-grava; parte de um estado vazio se não existir. */
	update(mutator: (state: FindingsStateFile) => void): FindingsStateFile {
		const state = this.read() ?? emptyState(this.branch);
		mutator(state);
		state.updatedAt = new Date().toISOString();
		reorder(state);
		this.write(state);
		return state;
	}
}
