/**
 * Repositório das runs (servidor) — leitura/escrita dos artefatos e estado.
 *
 * Concentra o acesso a disco usado pelas rotas: lista de runs, detalhe,
 * findings, sync, envio à PR e artefatos. A validação de slug (path traversal)
 * continua em `artifacts.ts`.
 */

import { join, resolve } from "node:path";
import { type HoundsmanConfig, resolveArtifactDir } from "../core/config";
import {
	applyFindingUpdate,
	buildStateFromRunDir,
	emptyState,
	type FindingDecision,
	type FindingExecState,
	type FindingState,
	type FindingsFilter,
	FindingsRepository,
	type FindingsStateFile,
	type FindingsSummary,
	type FindingUpdate,
	fileReader,
	filterFindings,
	reorder,
	type SyncResult,
	summarize,
	syncState,
} from "../core/findings-state";
import {
	buildSubmitPreview,
	type GhRunner,
	resolvePrTarget,
	type SubmitSelection,
	submitFindings,
} from "../core/github-review";
import { STATE_FILE } from "../core/paths";
import {
	pingFindingsStatus,
	type RunStatus,
	type RunStatusFile,
	readRunStatus,
} from "../core/run-status";
import type { Severity } from "../core/types";
import { listRunSlugs, readRunFile, readRunJson, runDirForSlug } from "./artifacts";

/** Item da lista de execuções (sidebar) — já ordenado do mais recente ao antigo. */
export type RunListItem = {
	slug: string;
	branch: string;
	updatedAt?: string;
	status: RunStatus | null;
	summary: FindingsSummary;
};

/** Detalhe de uma run (cabeçalho da UI). */
export type RunDetail = {
	slug: string;
	branch: string;
	status: RunStatusFile | null;
	manifest: unknown;
	summary: FindingsSummary;
	watchdogs: string[];
	unclassified: string[];
	deleted: string[];
};

/** Resultado do envio dos findings à PR. */
export type SubmitResult =
	| { available: false; reason: string }
	| { available: true; target: unknown; outcome: unknown };

/** Acesso às runs de um diretório de artefatos. */
export class RunRepository {
	private readonly artifactDir: string;

	constructor(artifactDir: string) {
		this.artifactDir = artifactDir;
	}

	static fromConfig(config: HoundsmanConfig): RunRepository {
		return new RunRepository(resolveArtifactDir(config));
	}

	/** `true` se o slug aponta para uma run válida. */
	exists(slug: string): boolean {
		return runDirForSlug(this.artifactDir, slug) !== null;
	}

	/** Lista as runs com resumo (mais recentes primeiro). */
	list(): RunListItem[] {
		return (
			listRunSlugs(this.artifactDir)
				.map((slug) => {
					const dir = join(this.artifactDir, slug);
					const state = this.loadState(dir, slug);
					const manifest = readRunJson<{
						branch?: string;
						generatedAt?: string;
					}>(dir, "manifest.json");
					const status = readRunStatus(dir);
					return {
						slug,
						branch: state.branch || manifest?.branch || slug,
						updatedAt: status?.updatedAt ?? state.updatedAt,
						status: status?.status ?? null,
						summary: summarize(state),
					};
				})
				// Mais recentes primeiro (ISO 8601 compara lexicograficamente).
				.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
		);
	}

	/** Detalhe da run (null se o slug for inválido). */
	detail(slug: string): RunDetail | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const state = this.loadState(dir, slug);
		const classification = readRunJson<{
			watchdogs?: Record<string, string[]>;
			unclassified?: string[];
			deleted?: string[];
		}>(dir, "classification.json");
		return {
			slug,
			branch: state.branch || slug,
			status: readRunStatus(dir),
			manifest: readRunJson(dir, "manifest.json"),
			summary: summarize(state),
			watchdogs: Object.keys(classification?.watchdogs ?? {}),
			unclassified: classification?.unclassified ?? [],
			deleted: classification?.deleted ?? [],
		};
	}

	/** Findings filtrados + resumo (null se o slug for inválido). */
	findings(
		slug: string,
		params: URLSearchParams,
	): {
		branch: string;
		findings: (FindingState & { absFile: string })[];
		summary: FindingsSummary;
	} | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const state = this.loadState(dir, slug);
		const filter: FindingsFilter = {
			decision: (params.get("decision") as FindingDecision) || undefined,
			execState: (params.get("exec") as FindingExecState) || undefined,
			severity: (params.get("severity") as Severity) || undefined,
			watchdog: params.get("watchdog") || undefined,
			file: params.get("file") || undefined,
			includeAbsent: params.get("all") === "1",
		};
		return {
			branch: state.branch,
			findings: filterFindings(state, filter).map(toClientFinding),
			summary: summarize(state),
		};
	}

	/** Um finding (null se ausente/inválido). */
	finding(slug: string, id: string): (FindingState & { absFile: string }) | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const finding = this.loadState(dir, slug).findings[id];
		return finding ? toClientFinding(finding) : null;
	}

	/** Aplica uma atualização a um finding (null se ausente/inválido). */
	update(
		slug: string,
		id: string,
		body: FindingUpdate,
	): (FindingState & { absFile: string }) | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const store = this.store(dir, slug);
		const state = store.read() ?? this.buildForRun(dir, slug) ?? emptyState(slug);
		const finding = state.findings[id];
		if (!finding) return null;
		applyFindingUpdate(finding, body);
		reorder(state);
		store.write(state);
		pingFindingsStatus(dir, state);
		return toClientFinding(finding);
	}

	/** Reancora os findings contra os arquivos atuais. */
	sync(slug: string): {
		result: SyncResult;
		summary: FindingsSummary;
	} | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const store = this.store(dir, slug);
		const state = store.read() ?? this.buildForRun(dir, slug) ?? emptyState(slug);
		const result = syncState(state, fileReader(process.cwd()));
		store.write(state);
		pingFindingsStatus(dir, state);
		return { result, summary: summarize(state) };
	}

	/** Prévia do envio da revisão (candidatos + disponibilidade da PR). */
	submitPreview(slug: string, runner: GhRunner): unknown | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const state = this.loadState(dir, slug);
		const target = resolvePrTarget(runner, state.branch || slug);
		return buildSubmitPreview(state, target);
	}

	/** Envia os findings selecionados à PR (fail-open). */
	submit(
		slug: string,
		selection: SubmitSelection,
		runner: GhRunner,
	): SubmitResult | null {
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const state = this.loadState(dir, slug);
		const target = resolvePrTarget(runner, state.branch || slug);
		if (!target.ok) return { available: false, reason: target.reason };

		const outcome = submitFindings({
			state,
			target: target.target,
			runner,
			selection,
		});
		this.store(dir, slug).write(state);
		pingFindingsStatus(dir, state);
		return { available: true, target: target.target, outcome };
	}

	/** Conteúdo de um artefato (`json`/`md`) da run (null se não servível). */
	artifact(slug: string, name: string): { content: string; type: string } | null {
		if (!/\.(json|md)$/i.test(name)) return null;
		const dir = runDirForSlug(this.artifactDir, slug);
		if (!dir) return null;
		const content = readRunFile(dir, name);
		if (content === null) return null;
		const type = name.toLowerCase().endsWith(".json")
			? "application/json; charset=utf-8"
			: "text/markdown; charset=utf-8";
		return { content, type };
	}

	// -----------------------------------------------------------------------
	// Internos
	// -----------------------------------------------------------------------

	private store(dir: string, slug: string): FindingsRepository {
		return new FindingsRepository(join(dir, STATE_FILE), slug);
	}

	private buildForRun(dir: string, slug: string): FindingsStateFile | null {
		const manifest = readRunJson<{ branch?: string }>(dir, "manifest.json");
		return buildStateFromRunDir(
			dir,
			manifest?.branch ?? slug,
			fileReader(process.cwd()),
		);
	}

	/**
	 * Lê o estado da run. Se ausente, reconstrói dos artefatos e PERSISTE — os ids
	 * são aleatórios, então precisam ser estáveis entre requisições.
	 */
	private loadState(dir: string, slug: string): FindingsStateFile {
		const store = this.store(dir, slug);
		const existing = store.read();
		if (existing) return existing;
		const built = this.buildForRun(dir, slug);
		if (built) {
			store.write(built);
			return built;
		}
		return emptyState(slug);
	}
}

/**
 * Finding + caminho absoluto. O cliente monta o link `vscode://file/...` e não
 * conhece o cwd do servidor — o caminho relativo do relatório não basta.
 */
function toClientFinding(finding: FindingState): FindingState & { absFile: string } {
	return { ...finding, absFile: resolve(process.cwd(), finding.file) };
}
