/**
 * Envio dos findings como comentários na Pull Request (biblioteca), via GitHub
 * CLI (`gh`) — a capability de **"enviar revisão"**.
 *
 * Um comentário **inline** por finding (na linha do diff) via
 * `POST repos/{repo}/pulls/{n}/comments`; findings sem linha — ou cuja linha o
 * GitHub rejeita — vão para **um** comentário geral da PR. O `id`/URL de cada
 * comentário é gravado no finding (`FindingState.github`): evita reenvio e
 * mantém o vínculo local↔remoto.
 *
 * O `gh` é OPCIONAL e falha-aberto: sem binário/login/PR a prévia volta
 * `available:false` e o envio é no-op (como o resto do houndsman).
 */

import {
	compareFindings,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsStateFile,
} from "./findings-state";
import { SEVERITY_EMOJI, type Severity } from "./types";

// ---------------------------------------------------------------------------
// Runner do `gh` (injetável nos testes)
// ---------------------------------------------------------------------------

export type GhResult = { ok: boolean; code: number; stdout: string; stderr: string };

/** Executa o `gh` e devolve o resultado cru (sem lançar). */
export type GhRunner = (args: string[]) => GhResult;

/** Runner padrão: `gh` a partir do cwd; ausência do binário → `ok:false`. */
export const defaultGhRunner: GhRunner = (args) => {
	try {
		const result = Bun.spawnSync(["gh", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = result.exitCode ?? 1;
		return {
			ok: code === 0,
			code,
			stdout: new TextDecoder().decode(result.stdout).trim(),
			stderr: new TextDecoder().decode(result.stderr).trim(),
		};
	} catch (error) {
		return {
			ok: false,
			code: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
};

// ---------------------------------------------------------------------------
// Alvo (PR + repositório)
// ---------------------------------------------------------------------------

export type PrTarget = {
	/** Número da PR. */
	number: number;
	/** `owner/name`. */
	repo: string;
	/** SHA do head revisado (base do `commit_id` dos comentários). */
	headSha?: string;
	url?: string;
};

export type TargetResult = { ok: true; target: PrTarget } | { ok: false; reason: string };

/** Extrai `owner/name` de uma URL de PR do GitHub. `null` se não casar. */
function repoFromUrl(url: string | undefined): string | null {
	if (!url) return null;
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
	return match ? `${match[1]}/${match[2]}` : null;
}

/** Mensagem curta para um erro do `gh`. */
function shortError(result: GhResult): string {
	if (result.code === 127 || /not found|ENOENT/i.test(result.stderr)) {
		return "gh não instalado.";
	}
	const last = result.stderr.split("\n").filter(Boolean).pop() ?? "";
	if (/auth|login|logged/i.test(last)) return `gh sem autenticação (${last}).`;
	return last || `gh saiu com código ${result.code}.`;
}

/**
 * Resolve a PR da branch + o repositório via `gh pr view`. Fail-open: devolve
 * `{ ok:false, reason }` quando não há `gh`, login ou PR.
 */
export function resolvePrTarget(runner: GhRunner, branch: string): TargetResult {
	const view = runner(["pr", "view", branch, "--json", "number,url,headRefOid"]);
	if (!view.ok) return { ok: false, reason: shortError(view) };

	let payload: { number?: number; url?: string; headRefOid?: string };
	try {
		payload = JSON.parse(view.stdout) as typeof payload;
	} catch {
		return { ok: false, reason: "Resposta inválida do gh." };
	}

	const repo = repoFromUrl(payload.url);
	if (!payload.number || !repo) {
		return { ok: false, reason: "Não foi possível identificar a PR/repositório." };
	}
	return {
		ok: true,
		target: {
			number: payload.number,
			repo,
			headSha: payload.headRefOid,
			url: payload.url,
		},
	};
}

// ---------------------------------------------------------------------------
// Seleção
// ---------------------------------------------------------------------------

export type SubmitSelection = {
	/** Severidades incluídas (vazio = todas). */
	severities?: Severity[];
	/** Estados de execução incluídos (vazio = todos). */
	execStates?: FindingExecState[];
	/** Decisões incluídas (default: `pending` + `execute` — nunca `ignore`). */
	decisions?: FindingDecision[];
	/** Reenvia findings já vinculados a um comentário. */
	includeSent?: boolean;
};

/** Decisões elegíveis por padrão — o `ignore` (descartado na triagem) nunca sai. */
export const DEFAULT_SUBMIT_DECISIONS: readonly FindingDecision[] = [
	"pending",
	"execute",
];

export type SubmitCandidate = {
	id: string;
	file: string;
	line: number | null;
	severity: Severity;
	execState: FindingExecState;
	rule: string;
	message: string;
	/** Comentário inline possível (tem linha). */
	inline: boolean;
	/** Já vinculado a um comentário remoto. */
	sent: boolean;
	/** URL do comentário já enviado (quando houver). */
	sentUrl?: string;
	/** Será pulado (já enviado e `includeSent` desligado). */
	skip: boolean;
};

/**
 * Seleciona os findings elegíveis ao envio: presentes, decisão elegível (sem
 * `ignore`), casando os filtros de severidade/execução. Marca `sent`/`skip`.
 */
export function selectSubmitCandidates(
	state: FindingsStateFile,
	selection: SubmitSelection = {},
): SubmitCandidate[] {
	const severities = new Set<Severity>(selection.severities ?? []);
	const execStates = new Set<FindingExecState>(selection.execStates ?? []);
	const decisions = new Set<FindingDecision>(
		selection.decisions ?? DEFAULT_SUBMIT_DECISIONS,
	);
	const includeSent = selection.includeSent ?? false;

	return Object.values(state.findings)
		.filter((finding) => finding.present)
		.filter((finding) => decisions.has(finding.decision))
		.filter((finding) => severities.size === 0 || severities.has(finding.severity))
		.filter((finding) => execStates.size === 0 || execStates.has(finding.execState))
		.sort(compareFindings)
		.map((finding) => {
			const sent = Boolean(finding.github?.commentId);
			return {
				id: finding.id,
				file: finding.file,
				line: finding.line,
				severity: finding.severity,
				execState: finding.execState,
				rule: finding.rule,
				message: finding.message,
				inline: finding.line !== null,
				sent,
				sentUrl: finding.github?.url,
				skip: sent && !includeSent,
			};
		});
}

export type SubmitPreview = {
	available: boolean;
	reason?: string;
	target?: PrTarget;
	candidates: SubmitCandidate[];
	totals: {
		/** Total de candidatos (após os filtros). */
		candidates: number;
		/** Quantos serão efetivamente enviados. */
		toSend: number;
		/** Serão comentários inline. */
		inline: number;
		/** Vão para o comentário geral. */
		body: number;
		/** Já enviados (no total de candidatos). */
		sent: number;
	};
};

/** Monta a prévia do envio a partir do estado + alvo resolvido. */
export function buildSubmitPreview(
	state: FindingsStateFile,
	target: TargetResult,
	selection: SubmitSelection = {},
): SubmitPreview {
	const candidates = selectSubmitCandidates(state, selection);
	const toSend = candidates.filter((candidate) => !candidate.skip);
	return {
		available: target.ok,
		reason: target.ok ? undefined : target.reason,
		target: target.ok ? target.target : undefined,
		candidates,
		totals: {
			candidates: candidates.length,
			toSend: toSend.length,
			inline: toSend.filter((candidate) => candidate.inline).length,
			body: toSend.filter((candidate) => !candidate.inline).length,
			sent: candidates.filter((candidate) => candidate.sent).length,
		},
	};
}

// ---------------------------------------------------------------------------
// Corpo dos comentários
// ---------------------------------------------------------------------------

/** Corpo (markdown) do comentário inline de um finding. */
export function buildCommentBody(finding: FindingState): string {
	const lines = [
		`${SEVERITY_EMOJI[finding.severity]} **${finding.rule}** · _${finding.severity}_`,
		"",
		finding.message,
		"",
		`**Ação:** ${finding.action}`,
	];
	if (finding.evidence) lines.push("", "```", finding.evidence, "```");
	lines.push("", "_— houndsman_");
	return lines.join("\n");
}

/** Corpo (markdown) do comentário geral com os findings sem posição no diff. */
export function renderGeneralBody(findings: readonly FindingState[]): string {
	const lines = [
		"## Revisão do houndsman",
		"",
		"Achados sem posição no diff (comentados aqui):",
		"",
	];
	for (const finding of findings) {
		const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
		lines.push(
			`- ${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** \`${location}\` — ${finding.rule}`,
			`  ${finding.message}`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

export type PostedComment = {
	id: string;
	kind: "inline" | "comment";
	commentId: number;
	url?: string;
};

export type SubmitOutcome = {
	posted: PostedComment[];
	failed: { id: string; reason: string }[];
	skipped: { id: string; reason: string }[];
	/** Comentário geral (quando houve findings sem posição/falha de inline). */
	general?: { commentId: number; url?: string; ids: string[] };
};

type PostResult =
	| { ok: true; commentId: number; url?: string }
	| { ok: false; reason: string };

function parseComment(result: GhResult): PostResult {
	if (!result.ok) return { ok: false, reason: shortError(result) };
	try {
		const payload = JSON.parse(result.stdout) as { id?: number; html_url?: string };
		if (!payload.id) return { ok: false, reason: "resposta sem id." };
		return { ok: true, commentId: payload.id, url: payload.html_url };
	} catch {
		return { ok: false, reason: "resposta inválida do gh." };
	}
}

function commentArgs(target: PrTarget, finding: FindingState): string[] {
	const args = [
		"api",
		`repos/${target.repo}/pulls/${target.number}/comments`,
		"-f",
		`body=${buildCommentBody(finding)}`,
		"-f",
		`path=${finding.file}`,
		"-F",
		`line=${finding.line}`,
		"-f",
		"side=RIGHT",
	];
	if (target.headSha) args.push("-f", `commit_id=${target.headSha}`);
	return args;
}

/** Posta o comentário inline de um finding. */
export function postInline(
	runner: GhRunner,
	target: PrTarget,
	finding: FindingState,
): PostResult {
	return parseComment(runner(commentArgs(target, finding)));
}

/** Posta o comentário geral (fallback) com os findings sem posição no diff. */
export function postGeneral(
	runner: GhRunner,
	target: PrTarget,
	findings: readonly FindingState[],
): PostResult {
	return parseComment(
		runner([
			"api",
			`repos/${target.repo}/issues/${target.number}/comments`,
			"-f",
			`body=${renderGeneralBody(findings)}`,
		]),
	);
}

/**
 * Envia os findings selecionados: inline por finding; os sem linha — ou cuja
 * linha o GitHub rejeitar — vão para um único comentário geral. Muta o `state`
 * com o vínculo (`finding.github`); o caller persiste.
 */
export function submitFindings(options: {
	state: FindingsStateFile;
	target: PrTarget;
	runner: GhRunner;
	selection?: SubmitSelection;
	now?: string;
}): SubmitOutcome {
	const { state, target, runner } = options;
	const now = options.now ?? new Date().toISOString();
	const candidates = selectSubmitCandidates(state, options.selection);

	const outcome: SubmitOutcome = { posted: [], failed: [], skipped: [] };
	const deferred: FindingState[] = [];

	const link = (
		finding: FindingState,
		commentId: number,
		url: string | undefined,
		kind: "inline" | "comment",
	): void => {
		finding.github = { commentId, url, kind, pr: target.number, at: now };
		finding.updatedAt = now;
	};

	for (const candidate of candidates) {
		const finding = state.findings[candidate.id];
		if (!finding) continue;

		if (candidate.skip) {
			outcome.skipped.push({ id: candidate.id, reason: "já enviado." });
			continue;
		}
		if (!candidate.inline) {
			deferred.push(finding);
			continue;
		}

		const posted = postInline(runner, target, finding);
		if (posted.ok) {
			link(finding, posted.commentId, posted.url, "inline");
			outcome.posted.push({
				id: candidate.id,
				kind: "inline",
				commentId: posted.commentId,
				url: posted.url,
			});
		} else {
			outcome.failed.push({ id: candidate.id, reason: posted.reason });
			deferred.push(finding);
		}
	}

	if (deferred.length > 0) {
		const general = postGeneral(runner, target, deferred);
		if (general.ok) {
			for (const finding of deferred) {
				link(finding, general.commentId, general.url, "comment");
				outcome.posted.push({
					id: finding.id,
					kind: "comment",
					commentId: general.commentId,
					url: general.url,
				});
			}
			outcome.general = {
				commentId: general.commentId,
				url: general.url,
				ids: deferred.map((finding) => finding.id),
			};
		} else {
			for (const finding of deferred) {
				if (!outcome.failed.some((entry) => entry.id === finding.id)) {
					outcome.failed.push({ id: finding.id, reason: general.reason });
				}
			}
		}
	}

	return outcome;
}
