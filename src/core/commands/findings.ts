/**
 * Subcomando `findings` — triagem dos findings da revisão (biblioteca).
 *
 * Lê/grava o estado de triagem no storage (SQLite por default). Devolve o texto
 * pronto (markdown ou JSON) + exit code; o CLI decide o log/exit. O agente do
 * usuário usa `list`/`set`/`done` (e `batch` para lotes de correção) para
 * interagir sem abrir o banco à mão.
 *
 * Ids aceitam prefixo único (exato primeiro) — útil porque o id curto convive
 * com o UUID interno no banco.
 */

import { existsSync } from "node:fs";
import { AiClient } from "../ai/ai-client";
import { AiVerifier } from "../ai/features/verifier";
import { type HoundsmanConfig, resolveJevConcurrency } from "../config";
import { type ReviewContext, reviewContext } from "../engine/review-context";
import { ENV_NAMES } from "../env";
import {
	applyFindingUpdate,
	FINDING_DECISIONS,
	FINDING_EXEC_STATES,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsFilter,
	type FindingsStateFile,
	type FindingUpdate,
	filterFindings,
	reorder,
	resolveFindingId,
	summarize,
	syncState,
} from "../findings-state";
import {
	buildSubmitPreview,
	defaultGhRunner,
	resolvePrTarget,
	type SubmitOutcome,
	type SubmitPreview,
	type SubmitSelection,
	submitFindings,
	syncResolvedThreads,
} from "../github-review";
import { VERIFY_FILE } from "../paths";
import { currentBranch } from "../pr-context";
import { ProjectConfig } from "../project-config";
import { BatchPresenter } from "../renderers/batch-presenter";
import { FindingsPresenter } from "../renderers/findings-presenter";
import { VerifyPresenter } from "../renderers/verify-presenter";
import { pingFindingsStatus } from "../run-status";
import { systemClock } from "../services/clock";
import { FixBatchBuilder } from "../services/fix-batch-builder";
import type { GitRepository } from "../services/git-repository";
import { Verifier } from "../services/verifier";
import type { RepoIdentity, StorageProvider } from "../storage/types";
import { SEVERITY_ORDER, type Severity } from "../types";

export type FindingsCommandResult = {
	output: string;
	exitCode: number;
};

const VALUE_FLAGS = new Set([
	"--decision",
	"--exec",
	"--watchdog",
	"--severity",
	"--file",
	"--branch",
	"--variant",
	"--limit",
	"--comment",
	"--by",
	"--offset",
	"--group",
]);

type ParsedArgs = {
	sub?: string;
	positionals: string[];
	values: Record<string, string>;
	bools: Set<string>;
};

/** Parse simples: primeiro não-flag = sub; demais = positionais. */
function parseArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = { positionals: [], values: {}, bools: new Set() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dir") {
			throw new Error(
				"--dir foi removido; configure `storage` no houndsman.config.ts.",
			);
		}
		if (arg.startsWith("--")) {
			if (VALUE_FLAGS.has(arg)) {
				const value = args[i + 1];
				if (value !== undefined) parsed.values[arg] = value;
				i++;
			} else {
				parsed.bools.add(arg);
			}
			continue;
		}
		if (!parsed.sub) parsed.sub = arg;
		else parsed.positionals.push(arg);
	}
	return parsed;
}

/** Opções de resolução do contexto (o CLI passa root/git do engine). */
export type FindingsContextOptions = {
	/** Raiz operacional (default: cwd de quem chamou). */
	root?: string;
	git?: GitRepository;
};

/** Resolve a review da branch atual (explícita ou via git). */
function openContext(
	storage: StorageProvider,
	repo: RepoIdentity,
	parsed: ParsedArgs,
	options: FindingsContextOptions = {},
): ReviewContext {
	const branch = parsed.values["--branch"] ?? currentBranch();
	const variant = parsed.values["--variant"]?.trim() || undefined;
	const review = storage.findReview(repo.key, branch, variant);
	if (!review) {
		throw new Error(
			`Nenhuma revisão para '${branch}'${variant ? ` (variante '${variant}')` : ""}. Rode \`houndsman --finalize\` primeiro.`,
		);
	}
	const worktree = review.worktreePath;
	// Sem worktree, mantém a raiz onde o comando foi invocado (comportamento histórico).
	const root =
		worktree && existsSync(worktree) ? worktree : (options.root ?? process.cwd());
	return reviewContext(storage, review, { root, git: options.git });
}

/** Lê o estado de triagem; lança se a review ainda não tem findings. */
function loadState(ctx: ReviewContext): FindingsStateFile {
	const state = ctx.storage.readFindings(ctx.review.id);
	if (!state) {
		throw new Error(
			`Nenhum estado de triagem para '${ctx.review.branch}'. Rode \`houndsman --finalize\` primeiro.`,
		);
	}
	return state;
}

/** Lê-modifica-grava o estado, atualizando `updatedAt` e a ordem. */
function mutateState(
	ctx: ReviewContext,
	mutator: (state: FindingsStateFile) => void,
): FindingsStateFile {
	const state = loadState(ctx);
	mutator(state);
	state.updatedAt = systemClock();
	reorder(state);
	ctx.storage.writeFindings(ctx.review.id, state);
	return state;
}

/** Resolve um id (exato ou prefixo único), lançando erro explicativo. */
function requireFindingId(state: FindingsStateFile, input: string): string {
	const resolution = resolveFindingId(state, input);
	if (resolution.status === "found") return resolution.id;
	if (resolution.status === "ambiguous") {
		throw new Error(
			`Id '${input}' ambíguo — candidatos: ${resolution.matches.join(", ")}.`,
		);
	}
	throw new Error(`Finding '${input}' não encontrado.`);
}

// ---------------------------------------------------------------------------
// Apresentação
// ---------------------------------------------------------------------------

const presenters = {
	findings: new FindingsPresenter(),
	batch: new BatchPresenter(),
	verify: new VerifyPresenter(),
};

const fixBatchBuilder = new FixBatchBuilder();

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function parseDecision(raw: string | undefined): FindingDecision | undefined {
	if (!raw) return undefined;
	if (!FINDING_DECISIONS.includes(raw as FindingDecision)) {
		throw new Error(
			`--decision inválido: '${raw}'. Use: ${FINDING_DECISIONS.join(", ")}.`,
		);
	}
	return raw as FindingDecision;
}

function parseExec(raw: string | undefined): FindingExecState | undefined {
	if (!raw) return undefined;
	if (!FINDING_EXEC_STATES.includes(raw as FindingExecState)) {
		throw new Error(
			`--exec inválido: '${raw}'. Use: ${FINDING_EXEC_STATES.join(", ")}.`,
		);
	}
	return raw as FindingExecState;
}

function filterFrom(parsed: ParsedArgs): FindingsFilter {
	const severity = parsed.values["--severity"];
	return {
		decision: parseDecision(parsed.values["--decision"]),
		execState: parseExec(parsed.values["--exec"]),
		watchdog: parsed.values["--watchdog"],
		severity: severity ? (severity as Severity) : undefined,
		file: parsed.values["--file"],
		includeAbsent: parsed.bools.has("--all"),
	};
}

/** Faz ping no status da review (derivado do estado atual) após uma mutação. */
function pingStatus(ctx: ReviewContext, state: FindingsStateFile): void {
	pingFindingsStatus(ctx.storage, ctx.review.id, state);
}

/**
 * Resolve no GitHub as threads dos findings recém-resolvidos localmente.
 * Fail-open (`gh` ausente/sem PR ⇒ só a mensagem). Devolve a linha para o
 * output ou `null` quando não há vínculo remoto pendente.
 */
function syncThreadsOutput(ctx: ReviewContext, ids: readonly string[]): string | null {
	if (ids.length === 0) return null;
	const state = loadState(ctx);
	const outcome = syncResolvedThreads({ state, ids });
	if (outcome.checked === 0) return null;
	if (outcome.updated.length > 0) ctx.storage.writeFindings(ctx.review.id, state);
	if (!outcome.available) {
		return `GitHub: threads não sincronizadas (${outcome.reason}).`;
	}
	const failures =
		outcome.failed.length > 0 ? `, ${outcome.failed.length} falha(s)` : "";
	return `GitHub: ${outcome.resolved.length} thread(s) resolvida(s), ${outcome.skipped.length} já resolvida(s)/pulada(s)${failures}.`;
}

/** Aplica uma atualização a um finding e persiste. */
function updateOne(
	ctx: ReviewContext,
	input: string,
	update: FindingUpdate,
): FindingState {
	let updated: FindingState | undefined;
	mutateState(ctx, (state) => {
		const id = requireFindingId(state, input);
		updated = applyFindingUpdate(state.findings[id], update);
	});
	if (!updated) throw new Error(`Finding '${input}' não encontrado.`);
	return updated;
}

/** Aplica a mesma atualização a vários ids (done/reset). */
function updateMany(
	ctx: ReviewContext,
	inputs: string[],
	update: FindingUpdate,
): FindingState[] {
	const updated: FindingState[] = [];
	mutateState(ctx, (state) => {
		const ids = inputs.map((input) => requireFindingId(state, input));
		for (const id of ids) {
			updated.push(applyFindingUpdate(state.findings[id], update));
		}
	});
	return updated;
}

/** Executa um subcomando de `findings` e devolve o texto + exit code. */
export function runFindingsCommand(
	config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	args: string[],
	options: FindingsContextOptions = {},
): FindingsCommandResult {
	try {
		const parsed = parseArgs(args);
		return execute(config, storage, repo, parsed, options);
	} catch (error) {
		return {
			output: error instanceof Error ? error.message : String(error),
			exitCode: 1,
		};
	}
}

function execute(
	_config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	parsed: ParsedArgs,
	options: FindingsContextOptions,
): FindingsCommandResult {
	const ctx = openContext(storage, repo, parsed, options);
	switch (parsed.sub ?? "list") {
		case "list": {
			const state = loadState(ctx);
			const filtered = filterFindings(state, filterFrom(parsed));
			const limit = Number(parsed.values["--limit"]);
			const findings =
				Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(findings, null, 2)
					: presenters.findings.list(state, findings),
				exitCode: 0,
			};
		}
		case "show": {
			const state = loadState(ctx);
			const input = parsed.positionals[0];
			if (!input) throw new Error("Informe o id: houndsman findings show <id>");
			const id = requireFindingId(state, input);
			const finding = state.findings[id];
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(finding, null, 2)
					: presenters.findings.list(state, [finding]),
				exitCode: 0,
			};
		}
		case "set": {
			const input = parsed.positionals[0];
			if (!input)
				throw new Error("Informe o id: houndsman findings set <id> [flags]");
			const update = updateFrom(parsed);
			if (!hasUpdate(update)) {
				throw new Error(
					"Nada para atualizar (use --decision, --exec ou --comment).",
				);
			}
			const finding = updateOne(ctx, input, update);
			pingStatus(ctx, loadState(ctx));
			const threads =
				update.execState === "done" ? syncThreadsOutput(ctx, [finding.id]) : null;
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(finding, null, 2)
					: [
							`Atualizado: \`${finding.id}\` → ${finding.decision}/${finding.execState}.`,
							threads,
						]
							.filter(Boolean)
							.join("\n"),
				exitCode: 0,
			};
		}
		case "done": {
			const ids = requireIds(parsed, "done");
			const updated = updateMany(ctx, ids, { execState: "done" });
			pingStatus(ctx, loadState(ctx));
			const threads = syncThreadsOutput(
				ctx,
				updated.map((finding) => finding.id),
			);
			return {
				output: [
					`Marcados como done: ${updated.map((f) => f.id).join(", ")}.`,
					threads,
				]
					.filter(Boolean)
					.join("\n"),
				exitCode: 0,
			};
		}
		case "reset": {
			const ids = requireIds(parsed, "reset");
			const updated = updateMany(ctx, ids, {
				decision: "pending",
				execState: "pending",
				comment: "",
			});
			pingStatus(ctx, loadState(ctx));
			return {
				output: `Triagem reiniciada: ${updated.map((f) => f.id).join(", ")}.`,
				exitCode: 0,
			};
		}
		case "sync": {
			const state = loadState(ctx);
			const result = syncState(state, ctx.files.reader());
			ctx.storage.writeFindings(ctx.review.id, state);
			pingStatus(ctx, state);
			const output = parsed.bools.has("--json")
				? JSON.stringify(result, null, 2)
				: [
						`Sync — ${ctx.review.branch}: ${result.ok} ok, ${result.moved.length} movido(s), ${result.stale.length} stale.`,
						result.moved.length > 0
							? `Movidos: ${result.moved.join(", ")}`
							: "",
						result.stale.length > 0
							? `Stale: ${result.stale.join(", ")}`
							: "",
					]
						.filter(Boolean)
						.join("\n");
			return { output, exitCode: 0 };
		}
		case "summary": {
			const state = loadState(ctx);
			const summary = summarize(state);
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(summary, null, 2)
					: presenters.findings.summary(state, summary),
				exitCode: 0,
			};
		}
		case "path": {
			return {
				output: ctx.storage.location(ctx.review.id),
				exitCode: 0,
			};
		}
		case "batch": {
			const state = loadState(ctx);
			const severity = parsed.values["--severity"];
			const offset = Number(parsed.values["--offset"]);
			const result = fixBatchBuilder.build(state, {
				severity: severity ? (severity as Severity) : undefined,
				includeDone: parsed.bools.has("--include-done"),
				offset: Number.isFinite(offset) ? offset : undefined,
				group: parsed.values["--group"],
			});
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(result, null, 2)
					: presenters.batch.render(result),
				exitCode: 0,
			};
		}
		default:
			return {
				output: `Subcomando '${parsed.sub}' desconhecido. Use: list, show, set, done, reset, sync, summary, batch, path.`,
				exitCode: 1,
			};
	}
}

function updateFrom(parsed: ParsedArgs): FindingUpdate {
	return {
		decision: parseDecision(parsed.values["--decision"]),
		execState: parseExec(parsed.values["--exec"]),
		comment: parsed.values["--comment"],
		by: parsed.values["--by"],
	};
}

function hasUpdate(update: FindingUpdate): boolean {
	return (
		update.decision !== undefined ||
		update.execState !== undefined ||
		update.comment !== undefined
	);
}

function requireIds(parsed: ParsedArgs, sub: string): string[] {
	if (parsed.positionals.length === 0) {
		throw new Error(`Informe ao menos um id: houndsman findings ${sub} <id...>`);
	}
	return parsed.positionals;
}

// ---------------------------------------------------------------------------
// verify — as violações foram resolvidas? (sem re-revisar a PR)
// ---------------------------------------------------------------------------

/**
 * Subcomando `findings verify` — checa se as violações foram resolvidas, sem
 * re-revisar a PR. Tier local (grátis) + confirmação Jev dos casos ambíguos
 * (fail-open). `--apply` persiste os `resolved` como `done`.
 */
export async function runVerifyCommand(
	config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	args: string[],
	options: FindingsContextOptions = {},
): Promise<FindingsCommandResult> {
	try {
		const parsed = parseArgs(args);
		return await executeVerify(config, storage, repo, parsed, options);
	} catch (error) {
		return {
			output: error instanceof Error ? error.message : String(error),
			exitCode: 1,
		};
	}
}

/** Trecho de ~20 linhas ao redor do finding (entrada da verificação por IA). */
function snippetsAround(content: string | null, line: number | null): string {
	if (!content) return "(arquivo indisponível)";
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const center = line && line > 0 ? line : 1;
	const start = Math.max(1, center - 10);
	const end = Math.min(lines.length, center + 10);
	return lines
		.slice(start - 1, end)
		.map((text, index) => `${start + index}: ${text}`)
		.join("\n")
		.slice(0, 4_000);
}

async function executeVerify(
	config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	parsed: ParsedArgs,
	options: FindingsContextOptions,
): Promise<FindingsCommandResult> {
	const ctx = openContext(storage, repo, parsed, options);
	const state = loadState(ctx);

	// Lazy: `../jev` (axios) só entra no caminho do verify.
	const verifier = new Verifier();
	const { JevCandidatesStore, JevClient, JevVerifier } = await import("../jev");

	const findings = verifier.select(state, filterFrom(parsed));
	const entries = verifier.verifyLocal(findings, ctx.files.reader());

	// Tier 1 — Jev só nos ambíguos (fail-open: sem chave/erro mantém o provisório).
	let jevChecked = 0;
	let jevReason: string | undefined;
	const ambiguous = entries.filter((entry) => entry.ambiguous);
	if (ambiguous.length > 0) {
		const jevVerifier = new JevVerifier(new JevClient());
		if (parsed.bools.has("--no-jev")) {
			jevReason = "desativado (--no-jev)";
		} else if (!jevVerifier.isConfigured()) {
			jevReason = `${ENV_NAMES.typeSafeApiKey} não configurada`;
		} else {
			const byId = new Map(findings.map((finding) => [finding.id, finding]));
			const outcome = await jevVerifier.verify(
				ambiguous.map((entry) => ({
					id: entry.id,
					file: entry.file,
					rule: entry.rule,
					foundAtSha: byId.get(entry.id)?.foundAtSha,
				})),
				{
					headSha: state.reviewed?.headSha,
					concurrency: resolveJevConcurrency(config),
				},
			);
			verifier.applyJev(entries, outcome.confidence, JevCandidatesStore.THRESHOLD);
			jevChecked = outcome.checked;
			jevReason = outcome.reason;
		}
	}

	// Tier 2 — IA opcional para os ambíguos que o Jev não respondeu.
	let aiChecked = 0;
	let aiReason: string | undefined;
	const stillAmbiguous = entries.filter(
		(entry) => entry.ambiguous && entry.basis === "anchor",
	);
	if (stillAmbiguous.length > 0) {
		const client = new AiClient({ project: new ProjectConfig(config) });
		const aiVerifier = new AiVerifier(client);
		if (parsed.bools.has("--no-ai")) {
			aiReason = "desativado (--no-ai)";
		} else if (!client.available) {
			aiReason = "IA não configurada";
		} else if (!aiVerifier.enabled) {
			aiReason = "feature ai.features.verify desligada";
		} else {
			const readFile = ctx.files.reader();
			const byId = new Map(findings.map((finding) => [finding.id, finding]));
			const confidence = await aiVerifier.verify({
				findings: stillAmbiguous.map((entry) => ({
					id: entry.id,
					rule: entry.rule,
					file: entry.file,
					line: entry.line,
					message: byId.get(entry.id)?.message ?? entry.message,
					snippets: snippetsAround(readFile(entry.file), entry.line),
				})),
			});
			aiChecked = verifier.applyConfidence(
				entries,
				confidence,
				JevCandidatesStore.THRESHOLD,
				"ai",
			);
			aiReason = `${aiChecked} caso(s) confirmado(s) pela IA`;
		}
	}

	const summary = verifier.summarize(entries);
	const location = ctx.storage.location(ctx.review.id);
	ctx.storage.writeArtifact(ctx.review.id, {
		name: VERIFY_FILE,
		kind: "verify",
		content: `${presenters.verify.render(state, entries, summary, { jevChecked, jevReason })}\n`,
	});

	let applied: string[] = [];
	if (parsed.bools.has("--apply")) {
		const current = mutateState(ctx, (draft) => {
			applied = verifier.applyResolutions(draft, entries);
		});
		pingStatus(ctx, current);
	}

	// Resolvidos localmente ⇒ resolve as conversas correspondentes no PR.
	const threads = syncThreadsOutput(ctx, applied);

	const output = parsed.bools.has("--json")
		? JSON.stringify(
				{
					branch: ctx.review.branch,
					summary,
					jevChecked,
					jevReason,
					aiChecked,
					aiReason,
					applied,
					entries,
				},
				null,
				2,
			)
		: [
				presenters.verify.render(state, entries, summary, {
					jevChecked,
					jevReason,
				}),
				"",
				`Relatório: ${location} (${VERIFY_FILE})`,
				parsed.bools.has("--apply")
					? `Aplicados (done): ${applied.length > 0 ? applied.join(", ") : "—"}.`
					: "",
				threads,
			]
				.filter(Boolean)
				.join("\n");

	const failOnPersisting =
		parsed.bools.has("--fail-on-persisting") &&
		entries.some(
			(entry) => entry.status === "persisting" && entry.severity === "blocking",
		);

	return { output, exitCode: failOnPersisting ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Envio (findings submit)
// ---------------------------------------------------------------------------

/** Flag de lista `a,b,c` → itens não vazios. */
function splitList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

/** Seleção do envio a partir das flags (`--severity`, `--decision`, `--exec`). */
function submitSelection(parsed: ParsedArgs): SubmitSelection {
	const severities = splitList(parsed.values["--severity"]).filter(
		(value): value is Severity =>
			(SEVERITY_ORDER as readonly string[]).includes(value),
	);
	const decisions = splitList(parsed.values["--decision"]).filter(
		(value): value is FindingDecision =>
			(FINDING_DECISIONS as readonly string[]).includes(value),
	);
	const execStates = splitList(parsed.values["--exec"]).filter(
		(value): value is FindingExecState =>
			(FINDING_EXEC_STATES as readonly string[]).includes(value),
	);
	return {
		severities: severities.length > 0 ? severities : undefined,
		decisions: decisions.length > 0 ? decisions : undefined,
		execStates: execStates.length > 0 ? execStates : undefined,
		includeSent: parsed.bools.has("--include-sent"),
	};
}

/** Render da prévia do envio (markdown ou JSON). */
function renderSubmitPreview(preview: SubmitPreview, json: boolean): string {
	if (json) return JSON.stringify(preview, null, 2);
	const totals = preview.totals;
	if (!preview.available) {
		return [
			`PR indisponível para envio: ${preview.reason}`,
			`Prévia local: ${totals.candidates} candidato(s) — ${totals.line} na linha · ${totals.file} no arquivo · ${totals.sent} já enviado(s).`,
		].join("\n");
	}
	const lines = [
		`# Envio da revisão — PR #${preview.target?.number} (${preview.target?.repo})`,
		"",
		`A enviar: ${totals.toSend} (${totals.line} na linha · ${totals.file} no arquivo) · já enviados: ${totals.sent}`,
	];
	if (totals.toSend === 0) lines.push("", "Nada a enviar.");
	return lines.join("\n");
}

/** Render do resultado do envio (markdown ou JSON). */
function renderSubmitOutcome(outcome: SubmitOutcome, json: boolean): string {
	if (json) return JSON.stringify(outcome, null, 2);
	const lines = [
		"# Envio da revisão",
		"",
		`Enviados: ${outcome.posted.length} · Falhas: ${outcome.failed.length} · Pulados: ${outcome.skipped.length}`,
	];
	const review = outcome.review;
	if (review?.id !== undefined) {
		const target = review.url ? ` — ${review.url}` : "";
		if (review.created) {
			const status = review.finalized
				? `finalizada (${review.event})`
				: "criada, mas não finalizada";
			lines.push(`Revisão #${review.id} ${status}${target}`);
		} else {
			lines.push(
				`Comentários adicionados à revisão pendente #${review.id}${target}`,
			);
		}
	}
	if (review?.error) lines.push(`Revisão: ❌ ${review.error}`);
	if (outcome.general) {
		lines.push(
			`Comentário geral: ${outcome.general.url ?? outcome.general.commentId} (${outcome.general.ids.length})`,
		);
	}
	for (const failure of outcome.failed) {
		lines.push(`- ❌ \`${failure.id}\`: ${failure.reason}`);
	}
	return lines.join("\n");
}

/**
 * Subcomando `findings submit` — envia os findings selecionados numa revisão da
 * PR (via `gh`): reaproveita a revisão pendente ou cria/finaliza uma nova.
 * `--dry-run` mostra a prévia sem postar. Assíncrono (gh).
 */
export async function runSubmitCommand(
	config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	args: string[],
	options: FindingsContextOptions = {},
): Promise<FindingsCommandResult> {
	try {
		const parsed = parseArgs(args);
		return await executeSubmit(config, storage, repo, parsed, options);
	} catch (error) {
		return {
			output: error instanceof Error ? error.message : String(error),
			exitCode: 1,
		};
	}
}

async function executeSubmit(
	_config: HoundsmanConfig,
	storage: StorageProvider,
	repo: RepoIdentity,
	parsed: ParsedArgs,
	options: FindingsContextOptions,
): Promise<FindingsCommandResult> {
	const ctx = openContext(storage, repo, parsed, options);
	const state = loadState(ctx);
	const selection = submitSelection(parsed);
	const target = resolvePrTarget(defaultGhRunner, state.branch);
	const preview = buildSubmitPreview(state, target, selection);
	const json = parsed.bools.has("--json");

	// Prévia explícita, ou alvo indisponível (fail-open) — nada a postar.
	if (parsed.bools.has("--dry-run") || !target.ok) {
		return { output: renderSubmitPreview(preview, json), exitCode: 0 };
	}

	const outcome = submitFindings({
		state,
		target: target.target,
		runner: defaultGhRunner,
		selection,
	});
	ctx.storage.writeFindings(ctx.review.id, state);
	pingStatus(ctx, state);

	return {
		output: renderSubmitOutcome(outcome, json),
		exitCode: outcome.failed.length > 0 || Boolean(outcome.review?.error) ? 1 : 0,
	};
}
