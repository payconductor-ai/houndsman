/**
 * Escopo da revisão (engine) — completo vs incremental.
 *
 * Decide se reconstrói o diff inteiro ou só o delta `prevSha..headSha` e
 * carrega os findings de arquivos inalterados (carry-over).
 */

import type { AstService } from "../ast/service";
import type { AstAnalysis, AstFacts } from "../ast/types";
import { buildChangedScope, type ChangedScope, type ScopeEntry } from "../changed-scope";
import type { HoundsmanConfig } from "../config";
import { churnToRecord, type DiffSource } from "../diff-source";
import { type ClassificationResult, parseEntries } from "../file-classifier";
import type { FindingsStateFile } from "../findings-state";
import type { MergedFinding } from "../report-builder";
import { FileClassifier } from "../services/file-classifier";
import { GitRepository } from "../services/git-repository";
import { buildCarryover } from "./carryover";

/** Opções que afetam o escopo (subset do `ReviewOptions`). */
export type ScopeOptions = {
	base: string;
	head: string;
	full: boolean;
	clean: boolean;
};

/** Classificação enriquecida gravada no `classification.json`. */
export type RunClassification = ClassificationResult & {
	/** Commit revisado (head do diff). */
	headSha?: string;
	/** Modo do prepare: completo ou incremental. */
	mode: "full" | "incremental";
	/** Commit da última revisão (só no incremental). */
	reviewedFrom?: string;
	/** Findings preservados do review anterior (arquivos inalterados). */
	carryover?: MergedFinding[];
	/** Faixas revisáveis por arquivo (símbolos alterados; hunks como fallback). */
	changedScope?: ChangedScope;
};

/** Resultado da resolução de escopo: revisar ou nada a fazer. */
export type ReviewScope =
	| {
			/** O `HEAD` é o mesmo commit já revisado — não há o que re-revisar. */
			kind: "noop";
			headSha: string;
			/** Commit já coberto pelo review anterior. */
			reviewedFrom: string;
	  }
	| {
			kind: "review";
			classification: RunClassification;
			diff: DiffSource;
			reviewedFrom?: string;
			/** Fatos/delta por arquivo alterado (quando o AST está habilitado). */
			ast?: Map<string, AstAnalysis>;
	  };

/** Etapas da resolução de escopo reportadas ao CLI (sem log no core). */
export type ScopeStage = "diff" | "ast" | "classify";

/** Evento de progresso de uma etapa do escopo. */
export type ScopeProgressEvent =
	| { type: "start"; stage: ScopeStage }
	| { type: "done"; stage: ScopeStage; durationMs: number };

/** Callback de progresso (falhas do callback são ignoradas). */
export type ScopeProgress = (event: ScopeProgressEvent) => void;

/** Decide entre review completo e incremental. */
export class ReviewScopeResolver {
	private readonly options: ScopeOptions;
	private readonly classifier: FileClassifier;
	private readonly ast?: AstService;
	private readonly git: GitRepository;
	private readonly onProgress?: ScopeProgress;

	constructor(
		options: ScopeOptions,
		config: HoundsmanConfig,
		ast?: AstService,
		git: GitRepository = new GitRepository(),
		onProgress?: ScopeProgress,
	) {
		this.options = options;
		this.classifier = new FileClassifier(config);
		this.ast = ast;
		this.git = git;
		this.onProgress = onProgress;
	}

	/**
	 * No-op quando o `HEAD` é exatamente o commit já revisado (sem
	 * `--full`/`--clean`): re-revisar a PR inteira seria desperdício, e o
	 * relatório anterior continua válido.
	 *
	 * Incremental só quando há um `reviewed.headSha` anterior, o `HEAD` atual o
	 * sucede (sem rebase) e não veio `--full`/`--clean`.
	 */
	async resolve(
		previous: FindingsStateFile | null,
		headSha: string,
	): Promise<ReviewScope> {
		const prevSha = previous?.reviewed?.headSha;

		if (!this.options.full && !this.options.clean && prevSha === headSha) {
			return { kind: "noop", headSha, reviewedFrom: headSha };
		}

		if (
			this.options.full ||
			this.options.clean ||
			!prevSha ||
			!this.git.isAncestor(prevSha, headSha)
		) {
			const diffData = this.step("diff", () => {
				const diff = this.git.collectDiff(this.options.base, this.options.head);
				const entries = parseEntries(
					this.git.diffNameStatus(this.options.base, this.options.head),
				);
				const baseRef =
					this.git.mergeBase(this.options.base, this.options.head) ??
					this.options.base;
				// Patch `-U0` sem truncar: mais preciso para delta AST e escopo.
				const scopeDiff = this.zeroContext(
					`${this.options.base}...${this.options.head}`,
					diff,
				);
				return { diff, entries, baseRef, scopeDiff };
			});
			const { diff, entries, baseRef, scopeDiff } = diffData;
			const astService = this.ast;
			const ast = astService
				? await this.stepAsync("ast", () =>
						astService.analyze(entries, scopeDiff, baseRef),
					)
				: undefined;
			const result = this.step("classify", () =>
				this.classifier
					.classify(entries, churnToRecord(diff.churn), factsOf(ast))
					.toJSON(),
			);
			return {
				kind: "review",
				diff,
				ast,
				classification: {
					...result,
					headSha,
					mode: "full",
					changedScope: buildChangedScope({
						entries: scopeEntries(entries, result),
						diff: scopeDiff,
						ast,
					}),
				},
			};
		}

		const range = `${prevSha}..${headSha}`;
		const diffData = this.step("diff", () => {
			const diff = this.git.collectDiffSince(prevSha, headSha);
			const entries = parseEntries(this.git.run(["diff", range, "--name-status"]));
			const scopeDiff = this.zeroContext(range, diff);
			return { diff, entries, scopeDiff };
		});
		const { diff, entries, scopeDiff } = diffData;
		const changedPaths = new Set(entries.map((entry) => entry.path));
		const astService = this.ast;
		const ast = astService
			? await this.stepAsync("ast", () =>
					astService.analyze(entries, scopeDiff, prevSha),
				)
			: undefined;
		const result = this.step("classify", () =>
			this.classifier
				.classify(entries, churnToRecord(diff.churn), factsOf(ast))
				.toJSON(),
		);
		const classification: RunClassification = {
			...result,
			base: prevSha,
			head: this.options.head,
			headSha,
			mode: "incremental",
			reviewedFrom: prevSha,
			carryover: buildCarryover(previous, changedPaths),
			changedScope: buildChangedScope({
				entries: scopeEntries(entries, result),
				diff: scopeDiff,
				ast,
			}),
		};
		return { kind: "review", classification, diff, reviewedFrom: prevSha, ast };
	}

	/**
	 * Executa uma etapa síncrona reportando início/fim. O callback de progresso
	 * é diagnóstico: nunca derruba a resolução.
	 */
	private step<T>(stage: ScopeStage, run: () => T): T {
		if (!this.onProgress) return run();
		const started = Date.now();
		this.report({ type: "start", stage });
		try {
			return run();
		} finally {
			this.report({ type: "done", stage, durationMs: Date.now() - started });
		}
	}

	/** Versão assíncrona de `step`. */
	private async stepAsync<T>(stage: ScopeStage, run: () => Promise<T> | T): Promise<T> {
		if (!this.onProgress) return run();
		const started = Date.now();
		this.report({ type: "start", stage });
		try {
			return await run();
		} finally {
			this.report({ type: "done", stage, durationMs: Date.now() - started });
		}
	}

	private report(event: ScopeProgressEvent): void {
		try {
			this.onProgress?.(event);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Patch `-U0` do intervalo; falha aberta cai no diff já coletado. */
	private zeroContext(range: string, fallback: DiffSource): DiffSource {
		try {
			const byFile = this.git.patchZeroContext(range);
			return byFile.size > 0 ? { byFile, churn: fallback.churn } : fallback;
		} catch {
			return fallback;
		}
	}
}

/** Fatos apenas dos arquivos presentes (deletados não classificam). */
function factsOf(
	analyses: ReadonlyMap<string, AstAnalysis> | undefined,
): ReadonlyMap<string, AstFacts> | undefined {
	if (!analyses) return undefined;
	const facts = new Map<string, AstFacts>();
	for (const [path, analysis] of analyses) {
		if (!analysis.deleted) facts.set(path, analysis.facts);
	}
	return facts;
}

/**
 * Entradas revisáveis do `--name-status`: exclui arquivos do `exclusions` e
 * deletados (não há código atual para ancorar finding).
 */
function scopeEntries(
	entries: ReturnType<typeof parseEntries>,
	result: ClassificationResult,
): ScopeEntry[] {
	const excluded = new Set(result.excluded);
	return entries
		.filter((entry) => entry.status !== "deleted" && !excluded.has(entry.path))
		.map((entry) => ({ path: entry.path, status: entry.status }));
}
