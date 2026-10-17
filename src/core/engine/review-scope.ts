/**
 * Escopo da revisão (engine) — completo vs incremental.
 *
 * Decide se reconstrói o diff inteiro ou só o delta `prevSha..headSha` e
 * carrega os findings de arquivos inalterados (carry-over).
 */

import type { AstService } from "../ast/service";
import type { AstAnalysis, AstFacts } from "../ast/types";
import type { HoundsmanConfig } from "../config";
import { churnToRecord, collectDiff, type DiffSource } from "../diff-source";
import { type ClassificationResult, parseEntries } from "../file-classifier";
import type { FindingsStateFile } from "../findings-state";
import { collectDiffSince, diffEntries, isAncestor } from "../git-revision";
import { runGit, tryGit } from "../git-runner";
import type { MergedFinding } from "../report-builder";
import { FileClassifier } from "../services/file-classifier";
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

/** Decide entre review completo e incremental. */
export class ReviewScopeResolver {
	private readonly options: ScopeOptions;
	private readonly classifier: FileClassifier;
	private readonly ast?: AstService;

	constructor(options: ScopeOptions, config: HoundsmanConfig, ast?: AstService) {
		this.options = options;
		this.classifier = new FileClassifier(config);
		this.ast = ast;
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
			!isAncestor(prevSha, headSha)
		) {
			const diff = collectDiff(this.options.base, this.options.head);
			const entries = parseEntries(
				runGit([
					"diff",
					`${this.options.base}...${this.options.head}`,
					"--name-status",
				]),
			);
			const baseRef =
				mergeBase(this.options.base, this.options.head) ?? this.options.base;
			const ast = this.ast
				? await this.ast.analyze(entries, diff, baseRef)
				: undefined;
			return {
				kind: "review",
				diff,
				ast,
				classification: {
					...this.classifier
						.classify(entries, churnToRecord(diff.churn), factsOf(ast))
						.toJSON(),
					headSha,
					mode: "full",
				},
			};
		}

		const range = `${prevSha}..${headSha}`;
		const diff = collectDiffSince(prevSha, headSha);
		const entries = diffEntries(range);
		const changedPaths = new Set(entries.map((entry) => entry.path));
		const ast = this.ast ? await this.ast.analyze(entries, diff, prevSha) : undefined;
		const classification: RunClassification = {
			...this.classifier
				.classify(entries, churnToRecord(diff.churn), factsOf(ast))
				.toJSON(),
			base: prevSha,
			head: this.options.head,
			headSha,
			mode: "incremental",
			reviewedFrom: prevSha,
			carryover: buildCarryover(previous, changedPaths),
		};
		return { kind: "review", classification, diff, reviewedFrom: prevSha, ast };
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

/** SHA do merge-base entre base e head (best effort). */
function mergeBase(base: string, head: string): string | null {
	const result = tryGit(["merge-base", base, head]);
	if (!result.ok) return null;
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : null;
}
