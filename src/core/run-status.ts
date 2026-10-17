/**
 * Status do run (biblioteca) — persistido em `.houndsman/.runs/<slug>/run.json`.
 *
 * Diz à UI em que pé está uma run: `reviewing` (revisando) → `review_done`
 * (revisão finalizada) → `fixing` (corrigindo) → `fix_done` (correção finalizada).
 *
 * Toda ação que muda o estado faz um **ping** no `updatedAt`, mantendo o arquivo
 * "quente". Timeout é **display-only** (a UI compara `updatedAt` com o agora) —
 * não é um status persistido.
 */

import { join } from "node:path";
import type { FindingsStateFile } from "./findings-state";
import { RUN_STATUS_FILE } from "./paths";
import { sanitizeBranch } from "./report-builder";
import { systemClock } from "./services/clock";
import { ProjectFiles } from "./services/project-files";

/** Estados de execução de uma run (persistidos). */
export type RunStatus = "reviewing" | "review_done" | "fixing" | "fix_done";

/** Valores canônicos de status (ordem de exibição/lifecycle). */
export const RUN_STATUSES: readonly RunStatus[] = [
	"reviewing",
	"review_done",
	"fixing",
	"fix_done",
];

export const RUN_STATUS_VERSION = 1;

/** Conteúdo do `run.json`. */
export type RunStatusFile = {
	version: 1;
	slug: string;
	branch: string;
	status: RunStatus;
	/** Início do ciclo de revisão atual (reiniciado a cada `prepare`). */
	startedAt: string;
	/** Última ação importante (ping). */
	updatedAt: string;
};

/** Caminho do `run.json` dentro da pasta da run. */
export function runStatusPath(runDir: string): string {
	return join(runDir, RUN_STATUS_FILE);
}

/** Lê o `run.json` da run (null se ausente/inválido). */
export function readRunStatus(runDir: string): RunStatusFile | null {
	return new ProjectFiles().readJson<RunStatusFile>(runStatusPath(runDir));
}

export type WriteRunStatusOptions = {
	branch: string;
	status: RunStatus;
	/** Reinicia o `startedAt` — usado no início de uma nova revisão. */
	resetStartedAt?: boolean;
	now?: string;
};

/** Grava/atualiza o `run.json` (ping no `updatedAt`). */
export function writeRunStatus(
	runDir: string,
	options: WriteRunStatusOptions,
): RunStatusFile {
	const files = new ProjectFiles();
	const now = options.now ?? systemClock();
	const previous = readRunStatus(runDir);
	const file: RunStatusFile = {
		version: RUN_STATUS_VERSION,
		slug: sanitizeBranch(options.branch),
		branch: options.branch,
		status: options.status,
		startedAt: options.resetStartedAt ? now : (previous?.startedAt ?? now),
		updatedAt: now,
	};
	files.write(runStatusPath(runDir), `${JSON.stringify(file, null, 2)}\n`);
	return file;
}

/**
 * Deriva o status após uma mudança nos findings (triagem/correção).
 * `fixing` exige correção em andamento (`in_progress`) ou retomada de um fix;
 * `fix_done` quando o fix começou e a fila (`execute` não `done`) esvaziou.
 */
export function statusAfterFindingsChange(
	previous: RunStatus | null,
	state: FindingsStateFile,
): RunStatus {
	const findings = Object.values(state.findings);
	const active = findings.filter((finding) => finding.present);

	if (active.some((finding) => finding.execState === "in_progress")) return "fixing";

	const queueRemaining = active.some(
		(finding) => finding.decision === "execute" && finding.execState !== "done",
	);
	const anyDone = active.some(
		(finding) => finding.decision === "execute" && finding.execState === "done",
	);
	const fixStarted = previous === "fixing" || previous === "fix_done" || anyDone;
	if (fixStarted) return queueRemaining ? "fixing" : "fix_done";

	return previous ?? "review_done";
}

/** Ping: deriva o status da mudança nos findings e grava o `run.json`. */
export function pingFindingsStatus(
	runDir: string,
	state: FindingsStateFile,
): RunStatusFile {
	const previous = readRunStatus(runDir)?.status ?? null;
	return writeRunStatus(runDir, {
		branch: state.branch,
		status: statusAfterFindingsChange(previous, state),
	});
}
