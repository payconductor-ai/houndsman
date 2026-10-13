/**
 * Subcomando `findings` — triagem dos findings da revisão (biblioteca).
 *
 * Lê/grava o `state.json` da run (`findings-state.ts`). Devolve o texto pronto
 * (markdown ou JSON) + exit code; o CLI decide o log/exit. O agente do usuário
 * usa `list`/`set`/`done` (e `batch` para lotes de correção) para interagir sem abrir o JSON à mão.
 *
 * Se o `state.json` não existir, é re-construído a partir de
 * `findings/*.json` + `classification.json` (não exige `--finalize`).
 */

import { type HoundsmanConfig, resolveArtifactDir } from "../config";
import {
	applyFindingUpdate,
	buildStateFromRunDir,
	FINDING_DECISIONS,
	FINDING_EXEC_STATES,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsFilter,
	type FindingsStateFile,
	FindingsStateStore,
	type FindingsSummary,
	type FindingUpdate,
	fileReader,
	filterFindings,
	runDir,
	summarize,
	syncState,
} from "../findings-state";
import { buildFixBatch, type FixBatchResult } from "../fix-batch";
import { relFromRoot } from "../paths";
import { currentBranch } from "../pr-context";
import { SEVERITY_EMOJI, SEVERITY_ORDER, type Severity } from "../types";

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
	"--dir",
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

/** Diretório da run + branch resolvida. */
function resolveDir(
	config: HoundsmanConfig,
	parsed: ParsedArgs,
): { dir: string; branch: string } {
	return {
		dir: parsed.values["--dir"] ?? resolveArtifactDir(config),
		branch: parsed.values["--branch"] ?? currentBranch(),
	};
}

/** Lê o estado da run; reconstrói dos findings se ausente. Lança se impossível. */
function loadState(config: HoundsmanConfig, parsed: ParsedArgs): FindingsStateFile {
	const { dir, branch } = resolveDir(config, parsed);
	const store = FindingsStateStore.at(dir, branch);
	const existing = store.read();
	if (existing) return existing;

	const built = buildStateFromRunDir(
		runDir(dir, branch),
		branch,
		fileReader(process.cwd()),
	);
	if (!built) {
		throw new Error(
			`Nenhum estado de triagem para '${branch}'. Rode \`houndsman --finalize\` primeiro.`,
		);
	}
	store.write(built);
	return built;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function decisionLabel(decision: FindingDecision): string {
	return decision;
}

/** Uma linha compacta por finding (uso no agente). */
function renderFindingLine(finding: FindingState): string[] {
	const emoji = SEVERITY_EMOJI[finding.severity];
	const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	const flags = `${decisionLabel(finding.decision)}/${finding.execState}`;
	const count = finding.count > 1 ? ` ×${finding.count}` : "";
	const lines = [
		`- \`${finding.id}\` ${emoji} **${finding.severity}** \`${location}\` — ${finding.rule}${count}`,
		`  ${finding.message}`,
		`  _${flags}_ · watchdogs: ${finding.watchdogIds.join(", ") || "—"}`,
	];
	if (finding.comment) lines.push(`  **Comentário:** ${finding.comment}`);
	return lines;
}

function renderList(state: FindingsStateFile, findings: FindingState[]): string {
	if (findings.length === 0) return "Nenhum finding para o filtro informado.";
	const lines = [`# Findings — ${state.branch} (${findings.length})`, ""];
	for (const finding of findings) lines.push(...renderFindingLine(finding));
	return lines.join("\n");
}

function renderSummary(state: FindingsStateFile, summary: FindingsSummary): string {
	const decisions = FINDING_DECISIONS.map((d) => `${d} ${summary.byDecision[d]}`).join(
		" · ",
	);
	const exec = FINDING_EXEC_STATES.map((e) => `${e} ${summary.byExecState[e]}`).join(
		" · ",
	);
	const severities = SEVERITY_ORDER.map((s) => `${s} ${summary.bySeverity[s]}`).join(
		" · ",
	);
	return [
		`# Triagem — ${state.branch}`,
		"",
		`Total: ${summary.total} (presentes: ${summary.present})`,
		`Decisões: ${decisions}`,
		`Execução: ${exec}`,
		`Severidade: ${severities}`,
	].join("\n");
}

/** Mix de severidade compacto (ex.: `❌1 ⚠️2`). */
function severityBreakdown(bySeverity: Record<Severity, number>): string {
	return SEVERITY_ORDER.filter((severity) => bySeverity[severity] > 0)
		.map((severity) => `${SEVERITY_EMOJI[severity]}${bySeverity[severity]}`)
		.join(" ");
}

/** Render do lote de correção: grupo atual paginado + outros grupos. */
function renderBatch(result: FixBatchResult): string {
	const { dimension, current, others, totals } = result;
	if (totals.queue === 0) return "Nenhum finding pendente de correção.";

	const lines = [
		`# Lote de correção — agrupado por ${dimension} (${totals.groups} grupo(s))`,
		"",
		`## Grupo atual — ${current.key} (${current.total} finding(s), mostrando ${current.returned})`,
	];
	for (const finding of current.findings) lines.push(...renderFindingLine(finding));
	if (current.remaining > 0) {
		lines.push("", `_… +${current.remaining} neste grupo (use \`--offset\`)._`);
	}
	if (others.length > 0) {
		lines.push("", "## Outros grupos disponíveis");
		for (const group of others) {
			lines.push(
				`- ${group.key} — ${group.count} (${severityBreakdown(group.bySeverity)})`,
			);
		}
	}
	lines.push(
		"",
		`fila: ${totals.queue} · retornados: ${totals.returned} · grupos: ${totals.groups}`,
	);
	return lines.join("\n");
}

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

/** Aplica uma atualização a um finding e persiste. */
function updateOne(
	config: HoundsmanConfig,
	parsed: ParsedArgs,
	id: string,
	update: FindingUpdate,
): FindingState {
	const { dir, branch } = resolveDir(config, parsed);
	const store = FindingsStateStore.at(dir, branch);
	let updated: FindingState | undefined;
	store.update((state) => {
		const finding = state.findings[id];
		if (!finding) return;
		updated = applyFindingUpdate(finding, update);
	});
	if (!updated) throw new Error(`Finding '${id}' não encontrado.`);
	return updated;
}

/** Aplica a mesma atualização a vários ids (done/reset). */
function updateMany(
	config: HoundsmanConfig,
	parsed: ParsedArgs,
	ids: string[],
	update: FindingUpdate,
): FindingState[] {
	const { dir, branch } = resolveDir(config, parsed);
	const store = FindingsStateStore.at(dir, branch);
	const updated: FindingState[] = [];
	store.update((state) => {
		for (const id of ids) {
			const finding = state.findings[id];
			if (!finding) continue;
			updated.push(applyFindingUpdate(finding, update));
		}
	});
	const missing = ids.filter((id) => !updated.some((f) => f.id === id));
	if (missing.length > 0) {
		throw new Error(`Findings não encontrados: ${missing.join(", ")}.`);
	}
	return updated;
}

/** Executa um subcomando de `findings` e devolve o texto + exit code. */
export function runFindingsCommand(
	config: HoundsmanConfig,
	args: string[],
): FindingsCommandResult {
	const parsed = parseArgs(args);
	try {
		return execute(config, parsed);
	} catch (error) {
		return {
			output: error instanceof Error ? error.message : String(error),
			exitCode: 1,
		};
	}
}

function execute(config: HoundsmanConfig, parsed: ParsedArgs): FindingsCommandResult {
	switch (parsed.sub ?? "list") {
		case "list": {
			const state = loadState(config, parsed);
			const filtered = filterFindings(state, filterFrom(parsed));
			const limit = Number(parsed.values["--limit"]);
			const findings =
				Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(findings, null, 2)
					: renderList(state, findings),
				exitCode: 0,
			};
		}
		case "show": {
			const state = loadState(config, parsed);
			const id = parsed.positionals[0];
			if (!id) throw new Error("Informe o id: houndsman findings show <id>");
			const finding = state.findings[id];
			if (!finding) throw new Error(`Finding '${id}' não encontrado.`);
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(finding, null, 2)
					: renderList(state, [finding]),
				exitCode: 0,
			};
		}
		case "set": {
			const id = parsed.positionals[0];
			if (!id) throw new Error("Informe o id: houndsman findings set <id> [flags]");
			const update = updateFrom(parsed);
			if (!hasUpdate(update)) {
				throw new Error(
					"Nada para atualizar (use --decision, --exec ou --comment).",
				);
			}
			const finding = updateOne(config, parsed, id, update);
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(finding, null, 2)
					: `Atualizado: \`${finding.id}\` → ${finding.decision}/${finding.execState}.`,
				exitCode: 0,
			};
		}
		case "done": {
			const ids = requireIds(parsed, "done");
			const updated = updateMany(config, parsed, ids, { execState: "done" });
			return {
				output: `Marcados como done: ${updated.map((f) => f.id).join(", ")}.`,
				exitCode: 0,
			};
		}
		case "reset": {
			const ids = requireIds(parsed, "reset");
			const updated = updateMany(config, parsed, ids, {
				decision: "pending",
				execState: "pending",
				comment: "",
			});
			return {
				output: `Triagem reiniciada: ${updated.map((f) => f.id).join(", ")}.`,
				exitCode: 0,
			};
		}
		case "sync": {
			const { dir, branch } = resolveDir(config, parsed);
			const store = FindingsStateStore.at(dir, branch);
			const state = loadState(config, parsed);
			const result = syncState(state, fileReader(process.cwd()));
			store.write(state);
			const output = parsed.bools.has("--json")
				? JSON.stringify(result, null, 2)
				: [
						`Sync — ${branch}: ${result.ok} ok, ${result.moved.length} movido(s), ${result.stale.length} stale.`,
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
			const state = loadState(config, parsed);
			const summary = summarize(state);
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(summary, null, 2)
					: renderSummary(state, summary),
				exitCode: 0,
			};
		}
		case "path": {
			const { dir, branch } = resolveDir(config, parsed);
			const path = FindingsStateStore.at(dir, branch).filePath;
			return { output: relFromRoot(path), exitCode: 0 };
		}
		case "batch": {
			const state = loadState(config, parsed);
			const severity = parsed.values["--severity"];
			const offset = Number(parsed.values["--offset"]);
			const result = buildFixBatch(state, {
				severity: severity ? (severity as Severity) : undefined,
				includeDone: parsed.bools.has("--include-done"),
				offset: Number.isFinite(offset) ? offset : undefined,
				group: parsed.values["--group"],
			});
			return {
				output: parsed.bools.has("--json")
					? JSON.stringify(result, null, 2)
					: renderBatch(result),
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
