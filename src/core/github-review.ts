/**
 * Envio dos findings como comentários na Pull Request (biblioteca), via GitHub
 * CLI (`gh`) — a capability de **"enviar revisão"**.
 *
 * Um comentário por finding via `POST repos/{repo}/pulls/{n}/comments`:
 * **na linha** do diff quando o finding tem linha; **no arquivo**
 * (`subject_type: file`) quando não tem. Se nenhum dos dois colar (ex.: arquivo
 * fora do diff), cai em **um** comentário geral da PR. O `id`/URL de cada
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
import { systemClock } from "./services/clock";
import { defaultGhRunner, type GhResult, type GhRunner } from "./services/gh-client";
import { SEVERITY_EMOJI, type Severity } from "./types";

export { type GhResult, type GhRunner, defaultGhRunner };

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
	/** Onde o comentário será ancorado: na linha do diff ou no arquivo. */
	kind: "line" | "file";
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
				kind: finding.line !== null ? "line" : "file",
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
		/** Comentários ancorados na linha do diff. */
		line: number;
		/** Comentários ancorados no arquivo (sem linha específica). */
		file: number;
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
			line: toSend.filter((candidate) => candidate.kind === "line").length,
			file: toSend.filter((candidate) => candidate.kind === "file").length,
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
	kind: "line" | "file" | "comment";
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

function commentArgs(
	target: PrTarget,
	finding: FindingState,
	mode: "line" | "file",
): string[] {
	const args = [
		"api",
		`repos/${target.repo}/pulls/${target.number}/comments`,
		"-f",
		`body=${buildCommentBody(finding)}`,
		"-f",
		`path=${finding.file}`,
	];
	if (mode === "line") {
		args.push("-F", `line=${finding.line}`, "-f", "side=RIGHT");
	} else {
		// Sem linha específica: ancora no arquivo (comentário de nível de arquivo).
		args.push("-f", "subject_type=file");
	}
	if (target.headSha) args.push("-f", `commit_id=${target.headSha}`);
	return args;
}

/** Posta o comentário de review de um finding (na linha ou no arquivo). */
export function postComment(
	runner: GhRunner,
	target: PrTarget,
	finding: FindingState,
	mode: "line" | "file",
): PostResult {
	return parseComment(runner(commentArgs(target, finding, mode)));
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
 * Envia os findings selecionados: um comentário por finding — na linha do diff
 * ou no arquivo (`subject_type=file`). O que não colar em nenhum dos dois vai
 * para um único comentário geral. Muta o `state` com o vínculo
 * (`finding.github`); o caller persiste.
 */
export function submitFindings(options: {
	state: FindingsStateFile;
	target: PrTarget;
	runner: GhRunner;
	selection?: SubmitSelection;
	now?: string;
}): SubmitOutcome {
	const { state, target, runner } = options;
	const now = options.now ?? systemClock();
	const candidates = selectSubmitCandidates(state, options.selection);

	const outcome: SubmitOutcome = { posted: [], failed: [], skipped: [] };
	const deferred: FindingState[] = [];

	const link = (
		finding: FindingState,
		commentId: number,
		url: string | undefined,
		kind: "line" | "file" | "comment",
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

		// Tenta a linha (quando há) e depois o arquivo — o primeiro que colar vence.
		const modes: ("line" | "file")[] =
			candidate.kind === "line" ? ["line", "file"] : ["file"];
		let posted: PostResult | null = null;
		let reason = "";
		for (const mode of modes) {
			const attempt = postComment(runner, target, finding, mode);
			if (attempt.ok) {
				posted = attempt;
				link(finding, attempt.commentId, attempt.url, mode);
				outcome.posted.push({
					id: candidate.id,
					kind: mode,
					commentId: attempt.commentId,
					url: attempt.url,
				});
				break;
			}
			reason = attempt.reason;
		}
		if (!posted) {
			outcome.failed.push({ id: candidate.id, reason });
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
