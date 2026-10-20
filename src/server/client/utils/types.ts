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
	| "technical"
	| "domain-review"
	| "verify"
	| "ast"
	| "ast-impact"
	| "ai"
	| "ai-usage"
	| "ai-brief"
	| "harness-transcript"
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
	/** Worktree onde a run foi executada (ausente = clone principal). */
	worktreePath?: string;
	prNumber?: number;
	updatedAt?: string;
	startedAt?: string;
	/** Último sinal de vida de uma execução ativa (revisão/correção). */
	heartbeatAt?: string;
	status?: RunStatus | null;
	summary: Summary;
};

export type FindingsResponse = {
	branch: string;
	findings: Finding[];
	summary: Summary;
};

/** Editor detectado pelo servidor (base dos links de código). */
export type EditorKind = "vscode" | "jetbrains" | "none";

export type EditorContext = {
	kind: EditorKind;
	project?: string;
	product?: string;
};

/** Estado da árvore de trabalho (bloqueia o checkout quando suja). */
export type WorktreeState = {
	available: boolean;
	clean: boolean;
	changes: number;
	sample: string[];
};

/** PR aberta exibida na sidebar. */
export type PrListItem = {
	number: number;
	title: string;
	headRefName: string;
	baseRefName: string;
	author: string;
	updatedAt?: string;
	isDraft: boolean;
	reviewDecision?: string;
	url?: string;
	runSlug?: string;
	/** Worktree ativo da PR (revisão paralela). */
	worktreePath?: string;
};

export type PrListResponse = {
	available: boolean;
	reason?: string;
	currentBranch: string | null;
	worktree: WorktreeState;
	prs: PrListItem[];
};

export type CheckoutResponse =
	| { ok: true; number: number; branch: string | null }
	| {
			ok: false;
			reason: "dirty" | "git" | "gh";
			detail: string;
			changes?: string[];
	  };

/** Resultado de `DELETE /api/runs/:slug`. */
export type DeleteRunResponse = {
	deleted: boolean;
	worktreeRequested: boolean;
	worktreeRemoved: boolean;
	worktreePath?: string;
	warning?: string;
};

export type PrWorktreeResponse =
	| {
			ok: true;
			number: number;
			branch: string;
			path: string;
			head: string;
			created: boolean;
			warning?: string;
	  }
	| { ok: false; reason: string; detail: string };

/** Comentário normalizado da PR (thread ou geral). */
export type PrCommentView = {
	id: number;
	author: string;
	authorType: string;
	body: string;
	createdAt?: string;
	url?: string;
	path?: string;
	line: number | null;
	absFile?: string;
	replyTo?: number | null;
};

export type PrCommentThread = {
	id: number;
	path: string;
	line: number | null;
	absFile: string;
	comments: PrCommentView[];
};

export type PrCommentsResponse = {
	available: boolean;
	reason?: string;
	target?: { number: number; repo: string; url?: string };
	fetchedAt: string;
	threads: PrCommentThread[];
	issueComments: PrCommentView[];
	counts: { threads: number; inline: number; issue: number };
};

/** Manifesto da run (subset consumido pela aba de resumo). */
export type RunManifest = {
	branch?: string;
	base?: string;
	head?: string;
	generatedAt?: string;
	churn?: { additions: number; deletions: number };
	watchdogs?: {
		id: string;
		name: string;
		files: string[];
		overflow: number;
		status: "pending" | "done";
	}[];
	context?: {
		summarized: boolean;
		source?: {
			number?: number;
			title?: string;
			url?: string;
			base?: string;
			head?: string;
		} | null;
	};
	excludedCount?: number;
	deleted?: string[];
	unclassified?: string[];
};

/** Detalhe da run (`GET /api/runs/:slug`). */
export type RunDetail = {
	slug: string;
	branch: string;
	manifest: RunManifest | null;
	watchdogs: string[];
	unclassified: string[];
	deleted: string[];
};

/** `classification.json` — só o necessário para os cards do resumo. */
export type ClassificationArtifact = {
	files?: Record<string, { status: string; oldPath?: string }>;
	churn?: Record<string, { additions: number; deletions: number }>;
	watchdogs?: Record<string, string[]>;
};

/** Candidato ao envio da revisão (espelha `core/github-review.ts`). */
export type SubmitCandidate = {
	id: string;
	file: string;
	line: number | null;
	severity: Severity;
	/** Decisão da triagem (`execute` = "a executar"). */
	decision: Decision;
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
	review?: {
		id?: number;
		url?: string;
		created: boolean;
		finalized: boolean;
		event?: "COMMENT" | "REQUEST_CHANGES";
		error?: string;
	};
};

export type SubmitResponse = {
	available: boolean;
	reason?: string;
	target?: PrTarget;
	outcome?: SubmitOutcome;
};
