/**
 * Envio dos findings como comentários na Pull Request (biblioteca), via GitHub
 * CLI (`gh`) — a capability de **"enviar revisão"**.
 *
 * O envio é **agrupado numa revisão**: se já existe uma revisão PENDING do
 * usuário logado, as threads são adicionadas a ela (sem finalizar); caso
 * contrário o houndsman cria a revisão pendente, adiciona as threads e a
 * finaliza (`REQUEST_CHANGES` quando há blocking; senão `COMMENT`).
 *
 * Findings **sem linha** (ou cuja linha não cola no diff) continuam como
 * comentário de arquivo (`subject_type: file`) e, no limite, num único issue
 * comment. O `id`/URL de cada comentário é gravado no finding
 * (`FindingState.github`): evita reenvio e mantém o vínculo local↔remoto.
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
import { SEVERITY_EMOJI, SEVERITY_ORDER, type Severity } from "./types";

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

/** Evento de finalização da revisão criada pelo houndsman. */
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

/** Revisão remota (criada ou reaproveitada) do envio. */
export type ReviewOutcome = {
	/** Id numérico (databaseId) da revisão, quando conhecido. */
	id?: number;
	url?: string;
	/** O houndsman criou a revisão nesta execução. */
	created: boolean;
	/** A revisão criada foi submetida ao fim do envio. */
	finalized: boolean;
	event?: ReviewEvent;
	/** Falha ao localizar/criar/finalizar a revisão. */
	error?: string;
};

export type SubmitOutcome = {
	posted: PostedComment[];
	failed: { id: string; reason: string }[];
	skipped: { id: string; reason: string }[];
	/** Comentário geral (quando houve findings sem posição/falha de inline). */
	general?: { commentId: number; url?: string; ids: string[] };
	/** Revisão remota em que as threads foram postadas. */
	review?: ReviewOutcome;
};

type PostResult =
	| { ok: true; commentId: number; url?: string; threadId?: string }
	| { ok: false; reason: string };

type ReviewHandle = {
	/** Node ID (GraphQL) da revisão. */
	nodeId: string;
	/** Id numérico (databaseId) da revisão. */
	databaseId: number;
	url?: string;
};

type ReviewLookup =
	| { ok: true; prNodeId: string; pending?: ReviewHandle }
	| { ok: false; reason: string };

type ReviewHandleResult =
	| { ok: true; review: ReviewHandle }
	| { ok: false; reason: string };

type GraphqlVar = string | number | undefined;

type GraphqlResult =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; reason: string };

/** Objeto JSON como record (evita `any` ao navegar nas respostas do GraphQL). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as Record<string, unknown>;
}

/** Converte `resourcePath` do GraphQL na URL web do GitHub. */
function githubUrl(resourcePath: unknown): string | undefined {
	return typeof resourcePath === "string"
		? `https://github.com${resourcePath}`
		: undefined;
}

/** Executa uma operação GraphQL via `gh api graphql`. Falha-aberto. */
function runGraphql(
	runner: GhRunner,
	query: string,
	vars: Record<string, GraphqlVar> = {},
): GraphqlResult {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) continue;
		args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
	}
	const result = runner(args);
	if (!result.ok) return { ok: false, reason: shortError(result) };

	let payload: { data?: Record<string, unknown>; errors?: { message?: string }[] };
	try {
		payload = JSON.parse(result.stdout) as typeof payload;
	} catch {
		return { ok: false, reason: "resposta inválida do gh." };
	}
	if (payload.errors?.length) {
		const message = payload.errors
			.map((error) => error.message)
			.filter(Boolean)
			.join("; ");
		return { ok: false, reason: message || "erro do GraphQL." };
	}
	if (!payload.data) return { ok: false, reason: "resposta sem dados do GraphQL." };
	return { ok: true, data: payload.data };
}

const LOOKUP_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	viewer { login }
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			id
			reviews(last: 50, states: [PENDING]) {
				nodes { id databaseId resourcePath author { login } }
			}
		}
	}
}`;

const CREATE_REVIEW_MUTATION = `mutation($pr: ID!, $sha: GitObjectID) {
	addPullRequestReview(input: { pullRequestId: $pr, commitOID: $sha }) {
		pullRequestReview { id databaseId resourcePath }
	}
}`;

const ADD_THREAD_MUTATION = `mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
	addPullRequestReviewThread(input: {
		pullRequestReviewId: $review,
		path: $path,
		line: $line,
		side: RIGHT,
		body: $body
	}) {
		thread {
			id
			comments(first: 1) { nodes { id databaseId resourcePath } }
		}
	}
}`;

const SUBMIT_REVIEW_MUTATION = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String!) {
	submitPullRequestReview(input: {
		pullRequestReviewId: $review,
		event: $event,
		body: $body
	}) {
		pullRequestReview { id databaseId state }
	}
}`;

/**
 * Localiza a PR (node id) e a revisão PENDING do usuário logado, se houver.
 * Revisões pendentes só são visíveis para o próprio autor.
 */
export function lookupPendingReview(runner: GhRunner, target: PrTarget): ReviewLookup {
	const [owner, name] = target.repo.split("/");
	if (!owner || !name) return { ok: false, reason: "repositório inválido." };

	const result = runGraphql(runner, LOOKUP_QUERY, {
		owner,
		name,
		number: target.number,
	});
	if (!result.ok) return result;

	const repository = asRecord(result.data.repository);
	const pullRequest = asRecord(repository?.pullRequest);
	const prNodeId = typeof pullRequest?.id === "string" ? pullRequest.id : undefined;
	if (!prNodeId) return { ok: false, reason: "PR não encontrada no GraphQL." };

	const reviews = asRecord(pullRequest?.reviews);
	const viewer = asRecord(result.data.viewer);
	const viewerLogin =
		typeof viewer?.login === "string" ? viewer.login.toLowerCase() : undefined;
	const nodes = (Array.isArray(reviews?.nodes) ? reviews.nodes : [])
		.map((value) => asRecord(value))
		.filter((node) => {
			if (!viewerLogin) return true;
			const author = asRecord(node?.author);
			return (
				typeof author?.login === "string" &&
				author.login.toLowerCase() === viewerLogin
			);
		});
	const node = nodes.at(-1);
	const databaseId = typeof node?.databaseId === "number" ? node.databaseId : undefined;
	const nodeId = typeof node?.id === "string" ? node.id : undefined;
	const pending =
		nodeId && databaseId !== undefined
			? { nodeId, databaseId, url: githubUrl(node?.resourcePath) }
			: undefined;
	return { ok: true, prNodeId, pending };
}

/** Cria uma revisão PENDING (sem `event`) apontando para o head revisado. */
export function createPendingReview(
	runner: GhRunner,
	target: PrTarget,
	prNodeId: string,
): ReviewHandleResult {
	const result = runGraphql(runner, CREATE_REVIEW_MUTATION, {
		pr: prNodeId,
		sha: target.headSha,
	});
	if (!result.ok) return result;

	const mutation = asRecord(result.data.addPullRequestReview);
	const review = asRecord(mutation?.pullRequestReview);
	const nodeId = typeof review?.id === "string" ? review.id : undefined;
	const databaseId =
		typeof review?.databaseId === "number" ? review.databaseId : undefined;
	if (!nodeId || databaseId === undefined) {
		return { ok: false, reason: "resposta sem revisão." };
	}
	return {
		ok: true,
		review: { nodeId, databaseId, url: githubUrl(review?.resourcePath) },
	};
}

/** Adiciona uma thread de linha à revisão pendente. */
function addReviewThread(
	runner: GhRunner,
	reviewNodeId: string,
	finding: FindingState,
	line: number,
): PostResult {
	const result = runGraphql(runner, ADD_THREAD_MUTATION, {
		review: reviewNodeId,
		path: finding.file,
		line,
		body: buildCommentBody(finding),
	});
	if (!result.ok) return result;

	const mutation = asRecord(result.data.addPullRequestReviewThread);
	const thread = asRecord(mutation?.thread);
	const comments = asRecord(thread?.comments);
	const nodes = Array.isArray(comments?.nodes) ? comments.nodes : [];
	const comment = asRecord(nodes[0]);
	const commentId =
		typeof comment?.databaseId === "number" ? comment.databaseId : undefined;
	if (commentId === undefined) {
		return { ok: false, reason: "resposta sem comentário." };
	}
	return {
		ok: true,
		commentId,
		url: githubUrl(comment?.resourcePath),
		threadId: typeof thread?.id === "string" ? thread.id : undefined,
	};
}

/** Finaliza a revisão pendente com o evento indicado e um corpo resumo. */
function submitReview(
	runner: GhRunner,
	reviewNodeId: string,
	event: ReviewEvent,
	body: string,
): { ok: true } | { ok: false; reason: string } {
	const result = runGraphql(runner, SUBMIT_REVIEW_MUTATION, {
		review: reviewNodeId,
		event,
		body,
	});
	return result.ok ? { ok: true } : result;
}

/** Corpo (markdown) da revisão criada: resumo por severidade. */
export function renderReviewBody(candidates: readonly SubmitCandidate[]): string {
	const counts = SEVERITY_ORDER.map((severity) => {
		const total = candidates.filter(
			(candidate) => candidate.severity === severity,
		).length;
		return total > 0 ? `${SEVERITY_EMOJI[severity]} ${total} ${severity}` : null;
	}).filter((part): part is string => part !== null);

	const lines = [
		"## Revisão do houndsman",
		"",
		`${candidates.length} achado(s) revisado(s).`,
	];
	if (counts.length > 0) lines.push("", counts.join(" · "));
	lines.push("", "_— houndsman_");
	return lines.join("\n");
}

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

/** Posta o finding como comentário de arquivo (`subject_type=file`). */
export function postFileComment(
	runner: GhRunner,
	target: PrTarget,
	finding: FindingState,
): PostResult {
	const args = [
		"api",
		`repos/${target.repo}/pulls/${target.number}/comments`,
		"-f",
		`body=${buildCommentBody(finding)}`,
		"-f",
		`path=${finding.file}`,
		"-f",
		"subject_type=file",
	];
	if (target.headSha) args.push("-f", `commit_id=${target.headSha}`);
	return parseComment(runner(args));
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
 * Envia os findings selecionados agrupando as threads numa revisão do GitHub:
 * adiciona à revisão PENDING existente (sem finalizar) ou cria uma nova e a
 * finaliza ao fim do disparo. Findings sem linha e falhas de thread caem no
 * comentário de arquivo (`subject_type=file`) e, no limite, num único
 * comentário geral. Muta o `state` com o vínculo (`finding.github`); o caller
 * persiste.
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
		threadId?: string,
	): void => {
		finding.github = {
			commentId,
			url,
			kind,
			pr: target.number,
			at: now,
			threadId,
		};
		finding.updatedAt = now;
	};

	const toSend: SubmitCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.skip) {
			outcome.skipped.push({ id: candidate.id, reason: "já enviado." });
			continue;
		}
		toSend.push(candidate);
	}

	const lineCandidates = toSend.filter((candidate) => candidate.kind === "line");
	const fileCandidates = toSend.filter((candidate) => candidate.kind === "file");

	// Revisão: reaproveita a pendente ou cria uma nova (só quando há linha).
	let review: ReviewHandle | undefined;
	let reviewCreated = false;
	let reviewError: string | undefined;
	if (lineCandidates.length > 0) {
		const lookup = lookupPendingReview(runner, target);
		if (!lookup.ok) {
			reviewError = lookup.reason;
		} else if (lookup.pending) {
			review = lookup.pending;
		} else {
			const created = createPendingReview(runner, target, lookup.prNodeId);
			if (created.ok) {
				review = created.review;
				reviewCreated = true;
			} else {
				reviewError = created.reason;
			}
		}
	}

	/** Fallback: comentário de arquivo e depois comentário geral. */
	const postFallback = (candidate: SubmitCandidate, finding: FindingState): void => {
		const attempt = postFileComment(runner, target, finding);
		if (attempt.ok) {
			link(finding, attempt.commentId, attempt.url, "file");
			outcome.posted.push({
				id: candidate.id,
				kind: "file",
				commentId: attempt.commentId,
				url: attempt.url,
			});
			return;
		}
		outcome.failed.push({ id: candidate.id, reason: attempt.reason });
		deferred.push(finding);
	};

	// Threads na revisão; falha na linha cai para arquivo/geral.
	for (const candidate of lineCandidates) {
		const finding = state.findings[candidate.id];
		if (!finding || candidate.line === null) continue;

		if (!review) {
			outcome.failed.push({
				id: candidate.id,
				reason: reviewError ?? "revisão indisponível.",
			});
			continue;
		}

		const attempt = addReviewThread(runner, review.nodeId, finding, candidate.line);
		if (attempt.ok) {
			link(finding, attempt.commentId, attempt.url, "line", attempt.threadId);
			outcome.posted.push({
				id: candidate.id,
				kind: "line",
				commentId: attempt.commentId,
				url: attempt.url,
			});
			continue;
		}
		postFallback(candidate, finding);
	}

	// Findings sem linha: comentário de arquivo (com fallback em geral).
	for (const candidate of fileCandidates) {
		const finding = state.findings[candidate.id];
		if (!finding) continue;
		postFallback(candidate, finding);
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

	// A revisão criada é finalizada; a existente fica pendente para o usuário.
	if (lineCandidates.length > 0) {
		if (review) {
			const event: ReviewEvent = toSend.some(
				(candidate) => candidate.severity === "blocking",
			)
				? "REQUEST_CHANGES"
				: "COMMENT";
			let finalized = false;
			let error: string | undefined;
			if (reviewCreated) {
				const submitted = submitReview(
					runner,
					review.nodeId,
					event,
					renderReviewBody(toSend),
				);
				finalized = submitted.ok;
				if (!submitted.ok) error = submitted.reason;
			}
			outcome.review = {
				id: review.databaseId,
				url: review.url,
				created: reviewCreated,
				finalized,
				event: reviewCreated ? event : undefined,
				error,
			};
		} else {
			outcome.review = {
				created: false,
				finalized: false,
				error: reviewError ?? "revisão indisponível.",
			};
		}
	}

	return outcome;
}

// ---------------------------------------------------------------------------
// Resolução das threads (findings resolvidos localmente)
// ---------------------------------------------------------------------------

type ThreadInfo = { id: string; isResolved: boolean };

/** Threads do PR indexadas pelo `databaseId` do comentário. */
type ThreadsLookup =
	| { ok: true; threads: Map<number, ThreadInfo> }
	| { ok: false; reason: string };

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviewThreads(last: 100) {
				nodes {
					id
					isResolved
					comments(first: 50) { nodes { databaseId } }
				}
			}
		}
	}
}`;

const RESOLVE_THREAD_MUTATION = `mutation($thread: ID!) {
	resolveReviewThread(input: { threadId: $thread }) {
		thread { id isResolved }
	}
}`;

/** Indexa as threads do PR por comentário (`databaseId`). */
function lookupThreads(runner: GhRunner, target: PrTarget): ThreadsLookup {
	const [owner, name] = target.repo.split("/");
	if (!owner || !name) return { ok: false, reason: "repositório inválido." };

	const result = runGraphql(runner, THREADS_QUERY, {
		owner,
		name,
		number: target.number,
	});
	if (!result.ok) return result;

	const repository = asRecord(result.data.repository);
	const pullRequest = asRecord(repository?.pullRequest);
	const reviewThreads = asRecord(pullRequest?.reviewThreads);
	const threads = new Map<number, ThreadInfo>();
	const nodes = Array.isArray(reviewThreads?.nodes) ? reviewThreads.nodes : [];
	for (const value of nodes) {
		const node = asRecord(value);
		const id = typeof node?.id === "string" ? node.id : undefined;
		if (!id) continue;
		const isResolved = node?.isResolved === true;
		const comments = asRecord(node?.comments);
		const commentNodes = Array.isArray(comments?.nodes) ? comments.nodes : [];
		for (const entry of commentNodes) {
			const comment = asRecord(entry);
			if (typeof comment?.databaseId === "number") {
				threads.set(comment.databaseId, { id, isResolved });
			}
		}
	}
	return { ok: true, threads };
}

export type ThreadSyncOutcome = {
	/** Findings com comentário de revisão avaliados. */
	checked: number;
	/** Threads resolvidas nesta execução. */
	resolved: { id: string; threadId: string }[];
	/** Já resolvidas no GitHub ou sem thread (ex.: comentário geral). */
	skipped: { id: string; reason: string }[];
	failed: { id: string; reason: string }[];
	/** Ids cujo vínculo local mudou (`threadId`/`resolvedAt`) — persistir o estado. */
	updated: string[];
};

/** Resultado do sync de alto nível (inclui indisponibilidade do `gh`/PR). */
export type ResolvedThreadsSync = ThreadSyncOutcome & {
	available: boolean;
	reason?: string;
};

const EMPTY_THREAD_OUTCOME = (): ThreadSyncOutcome => ({
	checked: 0,
	resolved: [],
	skipped: [],
	failed: [],
	updated: [],
});

/**
 * Resolve no GitHub as conversas dos findings indicados, pulando as que já
 * estão resolvidas. Muta `finding.github` (`threadId`/`resolvedAt`) para evitar
 * reconsultas — o caller persiste o estado. Fail-open: devolve `failed`/`skipped`
 * por finding, nunca lança.
 */
export function resolveFindingThreads(options: {
	runner: GhRunner;
	target: PrTarget;
	findings: readonly FindingState[];
	now?: string;
}): ThreadSyncOutcome {
	const { runner, target } = options;
	const now = options.now ?? systemClock();
	const outcome = EMPTY_THREAD_OUTCOME();

	// Comentário geral (issue comment) não tem thread resolvível.
	const linked = options.findings.filter(
		(finding) => finding.github && finding.github.kind !== "comment",
	);
	outcome.checked = linked.length;
	if (linked.length === 0) return outcome;

	const lookup = lookupThreads(runner, target);
	if (!lookup.ok) {
		for (const finding of linked) {
			outcome.failed.push({ id: finding.id, reason: lookup.reason });
		}
		return outcome;
	}

	const handled = new Set<string>();
	const updated = new Set<string>();
	const markUpdated = (id: string): void => {
		if (updated.has(id)) return;
		updated.add(id);
		outcome.updated.push(id);
	};
	for (const finding of linked) {
		const link = finding.github;
		if (!link) continue;
		const thread = lookup.threads.get(link.commentId);
		if (!thread) {
			outcome.skipped.push({
				id: finding.id,
				reason: "thread não encontrada no PR.",
			});
			continue;
		}
		if (handled.has(thread.id)) {
			outcome.skipped.push({
				id: finding.id,
				reason: "mesma thread de outro finding.",
			});
			continue;
		}
		handled.add(thread.id);

		if (link.threadId !== thread.id) {
			link.threadId = thread.id;
			markUpdated(finding.id);
		}
		if (thread.isResolved) {
			if (!link.resolvedAt) {
				link.resolvedAt = now;
				markUpdated(finding.id);
			}
			outcome.skipped.push({ id: finding.id, reason: "já resolvida no GitHub." });
			continue;
		}

		const result = runGraphql(runner, RESOLVE_THREAD_MUTATION, { thread: thread.id });
		if (result.ok) {
			link.resolvedAt = now;
			finding.updatedAt = now;
			markUpdated(finding.id);
			outcome.resolved.push({ id: finding.id, threadId: thread.id });
		} else {
			outcome.failed.push({ id: finding.id, reason: result.reason });
		}
	}
	return outcome;
}

/**
 * Sincroniza as threads dos findings já resolvidos localmente (`done`):
 * resolve o alvo via `gh pr view` e delega ao `resolveFindingThreads`.
 * Fail-open — sem `gh`/login/PR devolve `available:false` sem lançar.
 */
export function syncResolvedThreads(options: {
	state: FindingsStateFile;
	ids: readonly string[];
	runner?: GhRunner;
	now?: string;
}): ResolvedThreadsSync {
	const runner = options.runner ?? defaultGhRunner;
	const findings = options.ids
		.map((id) => options.state.findings[id])
		.filter(
			(finding): finding is FindingState =>
				Boolean(finding?.github) && finding?.github?.kind !== "comment",
		);
	if (findings.length === 0) return { available: true, ...EMPTY_THREAD_OUTCOME() };

	const target = resolvePrTarget(runner, options.state.branch);
	if (!target.ok) {
		const outcome = EMPTY_THREAD_OUTCOME();
		outcome.checked = findings.length;
		return { available: false, reason: target.reason, ...outcome };
	}
	return {
		available: true,
		...resolveFindingThreads({
			runner,
			target: target.target,
			findings,
			now: options.now,
		}),
	};
}
