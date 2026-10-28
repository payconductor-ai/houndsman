/**
 * Estado de triagem dos findings (biblioteca).
 *
 * O dump (`state.json`) é um detalhe do provider de arquivos; no SQLite o
 * estado é reconstruído de `findings` + `finding_history`. Cada finding tem um
 * `id` curto e um `fingerprint` de conteúdo: nas re-execuções do `--finalize`
 * o estado é preservado casando por fingerprint.
 *
 * A `line` é cache — `syncState` a recalcula após edições (auto-fix) e marca
 * `stale` quando a âncora some.
 */

import { randomUUID } from "node:crypto";
import {
	buildAnchor,
	type FindingAnchor,
	fingerprintOf,
	locateAnchor,
	reanchor,
} from "./finding-anchor";
import { normalizeFindingPath, ruleIdentityKey } from "./finding-identity";
import { type FindingBasis, type MergedFinding, sanitizeBranch } from "./report-builder";
import { systemClock } from "./services/clock";
import { type FileReader, ProjectFiles } from "./services/project-files";
import { isImpactClass } from "./severity";
import { SEVERITY_ORDER, type Severity, severityRank } from "./types";

export type { FileReader };

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

/**
 * Vínculo com o comentário remoto no GitHub (envio da revisão). Gravado pelo
 * `findings submit` / UI — permite pular reenvios e abrir o comentário.
 */
export type GitHubLink = {
	/** Id do comentário (review comment inline ou issue comment geral). */
	commentId: number;
	url?: string;
	/** Origem do comentário remoto: linha, arquivo ou comentário geral. */
	kind: "line" | "file" | "comment";
	/** Número da PR de destino. */
	pr: number;
	/** Quando foi enviado (ISO). */
	at: string;
	/** Node ID da thread de revisão (GraphQL) — base para resolver a conversa. */
	threadId?: string;
	/** Quando a thread foi marcada como resolvida no GitHub (ISO). */
	resolvedAt?: string;
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
	/** Gatilho concreto do gap (fora de regra). */
	scenario?: string;
	/** Consequência observável do gap. */
	impact?: string;
	/** Confiança do revisor (0–1). */
	confidence?: number;
	/** Origem do achado: regra, lógica ou domínio. */
	basis?: FindingBasis;
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
	/** Vínculo com o comentário remoto no GitHub (envio da revisão). */
	github?: GitHubLink;
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

/** Leitor padrão a partir do cwd (null se ausente/ilegível). */
export function fileReader(cwd: string): FileReader {
	return new ProjectFiles(cwd).reader();
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
		updatedAt: systemClock(),
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

/** Resultado da resolução de um id (completo ou prefixo único). */
export type FindingIdResolution =
	| { status: "found"; id: string }
	| { status: "ambiguous"; matches: string[] }
	| { status: "missing" };

/**
 * Resolve um id de finding: exato primeiro, depois prefixo único.
 * Ambíguo devolve os candidatos para a mensagem de erro.
 */
export function resolveFindingId(
	state: FindingsStateFile,
	input: string,
): FindingIdResolution {
	const needle = input.trim();
	if (needle.length === 0) return { status: "missing" };
	if (state.findings[needle]) return { status: "found", id: needle };

	const matches = Object.keys(state.findings).filter((id) =>
		id.toLowerCase().startsWith(needle.toLowerCase()),
	);
	if (matches.length === 1) return { status: "found", id: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };
	return { status: "missing" };
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
	/**
	 * Arquivos efetivamente revisados neste ciclo (união de `reviewedFiles`).
	 * Quando presente, só findings ausentes desses arquivos viram `done` — o que
	 * ficou fora do orçamento/skipped não pode ser dado como resolvido.
	 */
	reviewedPaths?: ReadonlySet<string>;
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
	const now = options.now ?? systemClock();
	const previous = options.previous ?? null;

	const result: Record<string, FindingState> = {};
	// 1. Preserva o estado anterior (marca como ausente até provar o contrário).
	const reviewedPaths = options.reviewedPaths;
	for (const prev of Object.values(previous?.findings ?? {})) {
		// Ausente do novo relatório ⇒ corrigido manualmente entre revisões (ou
		// some junto com o trecho): vira `done`. `ignore` é decisão explícita de
		// não corrigir — preserva o estado original. Arquivo fora da revisão
		// (orçamento/skipped) também preserva: ausência não prova resolução.
		const wasReviewed = !reviewedPaths || reviewedPaths.has(prev.file);
		const resolvedByReview =
			wasReviewed && prev.present && prev.decision !== "ignore";
		const queuedAndGone =
			wasReviewed && prev.decision === "execute" && prev.execState === "pending";
		result[prev.id] = {
			...prev,
			present: false,
			execState: resolvedByReview || queuedAndGone ? "done" : prev.execState,
			updatedAt: now,
		};
	}

	// 2. Findings atuais, agrupados por fingerprint.
	//
	// A regra entra normalizada (sem acento/caixa/pontuação e sem o prefixo
	// reservado): `Lógica: Falta validação` e `logica falta validacao` são o mesmo
	// achado, e o modelo reescreve o texto entre reviews.
	const previousIndex = new Map<string, FindingState>();
	for (const prev of Object.values(previous?.findings ?? {})) {
		previousIndex.set(prev.fingerprint, prev);
		// Ponte com o estado gravado antes da normalização: o fingerprint antigo
		// não casa mais, mas os ids triados não podem se perder.
		const recomputed = fingerprintOf(
			normalizeFindingPath(prev.file),
			ruleIdentityKey(prev.rule),
			prev.anchor,
			prev.message,
		);
		if (!previousIndex.has(recomputed)) previousIndex.set(recomputed, prev);
	}

	const byFingerprint = new Map<string, FindingState>();
	for (const finding of merged) {
		const content = options.readFile(finding.file);
		const anchor = content
			? buildAnchor(content, finding.line, finding.evidence)
			: null;
		const fingerprint = fingerprintOf(
			finding.file,
			ruleIdentityKey(finding.rule),
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

		const prev = previous ? previousIndex.get(fingerprint) : undefined;
		// Emergente sem `impactClass` (relatório legado) mantém a severidade já triada
		// para o mesmo fingerprint: o código é o mesmo, então o valor não pode oscilar
		// entre reviews. Regra e `impactClass` produzem valor determinístico e vencem.
		const sticky =
			(finding.basis ?? "rule") !== "rule" &&
			!isImpactClass(finding.impactClass) &&
			prev !== undefined;
		const created: FindingState = {
			id: prev?.id ?? newFindingId(),
			fingerprint,
			watchdogIds: [...finding.watchdogs],
			rule: finding.rule,
			severity: sticky && prev ? prev.severity : finding.severity,
			file: finding.file,
			line: anchor ? anchor.line : null,
			message: finding.message,
			action: finding.action,
			evidence: finding.evidence,
			scenario: finding.scenario,
			impact: finding.impact,
			confidence: finding.confidence,
			basis: finding.basis,
			anchor,
			// Carry-over preserva o `foundAtSha` original; novos/re-reportados usam o head atual.
			foundAtSha: finding.foundAtSha ?? options.headSha ?? prev?.foundAtSha,
			// Ocorrências colapsadas no dedupe (mesma regra no mesmo arquivo).
			count: Math.max(1, finding.occurrences ?? 1),
			present: true,
			decision: prev?.decision ?? "pending",
			comment: prev?.comment,
			execState: prev?.execState ?? "pending",
			createdAt: prev?.createdAt ?? now,
			updatedAt: now,
			history: prev?.history ?? [],
			github: prev?.github,
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
	now: string = systemClock(),
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
	now: string = systemClock(),
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
// Domínio (classes)
// ---------------------------------------------------------------------------

/** Um finding triável, com comportamento sobre o DTO serializável. */
export class Finding {
	readonly state: FindingState;

	constructor(state: FindingState) {
		this.state = state;
	}

	static from(state: FindingState): Finding {
		return new Finding(state);
	}

	get id(): string {
		return this.state.id;
	}

	get file(): string {
		return this.state.file;
	}

	get line(): number | null {
		return this.state.line;
	}

	get severity(): Severity {
		return this.state.severity;
	}

	get decision(): FindingDecision {
		return this.state.decision;
	}

	get execState(): FindingExecState {
		return this.state.execState;
	}

	get present(): boolean {
		return this.state.present;
	}

	get isDone(): boolean {
		return this.state.execState === "done";
	}

	/** Aplica uma atualização (com histórico) e devolve o próprio finding. */
	apply(update: FindingUpdate, now: string = systemClock()): Finding {
		applyFindingUpdate(this.state, update, now);
		return this;
	}

	/** Payload serializável (mesmo shape do `state.json`). */
	toJSON(): FindingState {
		return this.state;
	}
}

/** Coleção de triagem de uma run — superfície OO sobre o dump persistido. */
export class FindingsState {
	readonly file: FindingsStateFile;

	constructor(file: FindingsStateFile) {
		this.file = file;
	}

	static from(file: FindingsStateFile): FindingsState {
		return new FindingsState(file);
	}

	static empty(branch: string): FindingsState {
		return new FindingsState(emptyState(branch));
	}

	get branch(): string {
		return this.file.branch;
	}

	get reviewed(): FindingsReviewed | undefined {
		return this.file.reviewed;
	}

	/** Findings na ordem de exibição (`order`). */
	list(): Finding[] {
		return this.file.order
			.map((id) => this.file.findings[id])
			.filter((state): state is FindingState => Boolean(state))
			.map((state) => Finding.from(state));
	}

	/** Busca por id. */
	get(id: string): Finding | null {
		const state = this.file.findings[id];
		return state ? Finding.from(state) : null;
	}

	/** Todos os findings (ordem de inserção, sem o `order`). */
	values(): Finding[] {
		return Object.values(this.file.findings).map((state) => Finding.from(state));
	}

	/** Somente os presentes no último relatório. */
	present(): Finding[] {
		return this.values().filter((finding) => finding.present);
	}

	/** Filtra pela ordem canônica (presentes → severidade → arquivo → linha). */
	filter(filter: FindingsFilter = {}): Finding[] {
		return filterFindings(this.file, filter).map((state) => Finding.from(state));
	}

	/** Contagens por decisão, execução e severidade. */
	summarize(): FindingsSummary {
		return summarize(this.file);
	}

	/** Reordena os ids pela ordenação canônica. */
	reorder(): void {
		reorder(this.file);
	}

	/** Aplica uma atualização a um finding e devolve-o (null se ausente). */
	apply(id: string, update: FindingUpdate, now?: string): Finding | null {
		const state = this.file.findings[id];
		if (!state) return null;
		applyFindingUpdate(state, update, now);
		return Finding.from(state);
	}

	/** Reancora os presentes contra os arquivos atuais. */
	sync(readFile: FileReader, now?: string): SyncResult {
		return syncState(this.file, readFile, now);
	}

	/** Payload serializável (mesmo shape do `state.json`). */
	toJSON(): FindingsStateFile {
		return this.file;
	}
}

// ---------------------------------------------------------------------------
// Repository (I/O atômico)
// ---------------------------------------------------------------------------

/** Persistência do `state.json` — escrita atômica (tmp + rename). */
export class FindingsRepository {
	private readonly path: string;
	private readonly branch: string;
	private readonly files = new ProjectFiles();

	constructor(path: string, branch: string) {
		this.path = path;
		this.branch = branch;
	}

	get filePath(): string {
		return this.path;
	}

	/** Lê o estado; null se ausente/inválido. */
	read(): FindingsStateFile | null {
		const raw = this.files.readJson<FindingsStateFile>(this.path);
		if (!raw || raw.version !== FINDINGS_STATE_VERSION || !raw.findings) return null;
		return raw;
	}

	/** Grava o estado de forma atômica. */
	write(state: FindingsStateFile): void {
		this.files.writeAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
	}

	/** Lê-modifica-grava; parte de um estado vazio se não existir. */
	update(mutator: (state: FindingsStateFile) => void): FindingsStateFile {
		const state = this.read() ?? emptyState(this.branch);
		mutator(state);
		state.updatedAt = systemClock();
		reorder(state);
		this.write(state);
		return state;
	}
}

/** Nome anterior do repository (compatibilidade da API pública). */
export { FindingsRepository as FindingsStateStore };
