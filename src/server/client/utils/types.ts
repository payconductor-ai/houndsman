/**
 * Tipos compartilhados do cliente (espelham `src/core/findings-state.ts`).
 *
 * São um espelho minimalista do contrato da API — evita importar o núcleo
 * (Node) no bundle do navegador.
 */

export type Severity = "blocking" | "attention" | "suggestion" | "nit";
export type Decision = "pending" | "execute" | "ignore";
export type ExecState = "pending" | "in_progress" | "done" | "stale";

/** Estados de execução de uma run (espelham `core/run-status.ts`). */
export type RunStatus = "reviewing" | "review_done" | "fixing" | "fix_done";

/** Vínculo com o comentário remoto no GitHub (envio da revisão). */
export type GitHubLink = {
	commentId: number;
	url?: string;
	kind: "line" | "file" | "comment";
	pr: number;
	at: string;
};

export type Finding = {
	id: string;
	rule: string;
	severity: Severity;
	file: string;
	line: number | null;
	/** Caminho absoluto resolvido pelo servidor — base do link `vscode://file/…`. */
	absFile?: string;
	message: string;
	action: string;
	evidence?: string;
	count: number;
	present: boolean;
	decision: Decision;
	comment?: string;
	execState: ExecState;
	watchdogIds: string[];
	/** Comentário remoto no GitHub, quando já enviado. */
	github?: GitHubLink;
};

export type Summary = {
	total: number;
	present: number;
	byDecision: Record<Decision, number>;
	byExecState: Record<ExecState, number>;
	bySeverity: Record<Severity, number>;
};

/** Espécie de artefato persistido (espelha `core/storage/types.ts`). */
export type ArtifactKind =
	| "brief"
	| "classification"
	| "manifest"
	| "candidates"
	| "context"
	| "context-brief"
	| "context-summary"
	| "finding-report"
	| "review"
	| "resume"
	| "domain-review"
	| "verify"
	| "other";

/** Metadados de artefato retornados pela API (sem conteúdo). */
export type ArtifactMeta = {
	name: string;
	kind: ArtifactKind;
	contentType: string;
	updatedAt: string;
};

export type RunSummary = {
	slug: string;
	branch: string;
	updatedAt?: string;
	status?: RunStatus | null;
	summary: Summary;
};

export type FindingsResponse = {
	branch: string;
	findings: Finding[];
	summary: Summary;
};

/** Candidato ao envio da revisão (espelha `core/github-review.ts`). */
export type SubmitCandidate = {
	id: string;
	file: string;
	line: number | null;
	severity: Severity;
	execState: ExecState;
	rule: string;
	message: string;
	/** Onde o comentário será ancorado: na linha do diff ou no arquivo. */
	kind: "line" | "file";
	sent: boolean;
	sentUrl?: string;
	skip: boolean;
};

export type PrTarget = {
	number: number;
	repo: string;
	headSha?: string;
	url?: string;
};

export type SubmitPreview = {
	available: boolean;
	reason?: string;
	target?: PrTarget;
	candidates: SubmitCandidate[];
	totals: {
		candidates: number;
		toSend: number;
		line: number;
		file: number;
		sent: number;
	};
};

export type SubmitOutcome = {
	posted: {
		id: string;
		kind: "line" | "file" | "comment";
		commentId: number;
		url?: string;
	}[];
	failed: { id: string; reason: string }[];
	skipped: { id: string; reason: string }[];
	general?: { commentId: number; url?: string; ids: string[] };
};

export type SubmitResponse = {
	available: boolean;
	reason?: string;
	target?: PrTarget;
	outcome?: SubmitOutcome;
};
