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
};

export type Summary = {
	total: number;
	present: number;
	byDecision: Record<Decision, number>;
	byExecState: Record<ExecState, number>;
	bySeverity: Record<Severity, number>;
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
