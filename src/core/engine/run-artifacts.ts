/**
 * Artefatos persistidos de uma run (engine) — leitura/escrita tipada.
 *
 * Concentra `classification`, `candidates`, `manifest`, resumos e contexto para
 * que as pipelines não repitam `storage.readArtifact(...)`.
 */

import type { AstAnalysis, AstImpact } from "../ast/types";
import { GENERAL_WATCHDOG_ID } from "../builtins";
import { type BusinessSummary, parseBusinessSummary } from "../business-summary";
import type { HoundsmanConfig } from "../config";
import { type JevCandidatesFile, JevCandidatesStore, parseCandidates } from "../jev";
import {
	BUSINESS_BRIEF_FILE,
	BUSINESS_SUMMARY_FILE,
	TECHNICAL_SUMMARY_FILE,
} from "../paths";
import type {
	ManifestAi,
	ManifestAst,
	ManifestBusiness,
} from "../renderers/manifest-writer";
import { type ContextSummary, parseContextSummary } from "../report-builder";
import type { ReviewRecord, StorageProvider } from "../storage/types";
import type { ReviewWorkArea } from "../storage/work-area";
import {
	buildTechnicalSummary,
	parseTechnicalSummary,
	type TechnicalSummary,
} from "../technical-summary";
import type { RunClassification } from "./review-scope";

/** Acesso tipado aos artefatos de uma review. */
export class RunArtifacts {
	constructor(
		private readonly storage: StorageProvider,
		private readonly review: ReviewRecord,
		private readonly work: ReviewWorkArea,
	) {}

	/** JSON persistido, ou `null` quando ausente/inválido. */
	json<T>(name: string): T | null {
		const artifact = this.storage.readArtifact(this.review.id, name);
		if (!artifact) return null;
		try {
			return JSON.parse(artifact.content) as T;
		} catch {
			return null;
		}
	}

	/** Reaproveita `ast`/`ai`/`business` do manifesto anterior. */
	manifestExtras(): {
		ast?: ManifestAst;
		ai?: ManifestAi;
		business?: ManifestBusiness;
	} {
		const artifact = this.storage.readArtifact(this.review.id, "manifest.json");
		if (!artifact) return {};
		try {
			const parsed = JSON.parse(artifact.content) as {
				ast?: ManifestAst;
				ai?: ManifestAi;
				business?: ManifestBusiness;
			};
			return {
				ast: parsed.ast,
				ai: parsed.ai,
				business: parsed.business ?? undefined,
			};
		} catch {
			return {};
		}
	}

	/** Lê o `classification.json` persistido pelo prepare (lança se ausente). */
	classification(): RunClassification {
		const artifact = this.storage.readArtifact(this.review.id, "classification.json");
		if (!artifact) {
			throw new Error(
				`Não encontrei a classificação da review. Rode \`bun run houndsman\` (preparar) primeiro.`,
			);
		}
		return JSON.parse(artifact.content) as RunClassification;
	}

	/** Lê os candidatos Jev persistidos (unavailable se ausente/inválido). */
	candidates(config: HoundsmanConfig): JevCandidatesFile {
		const artifact = this.storage.readArtifact(this.review.id, "candidates.json");
		if (!artifact) return JevCandidatesStore.unavailable("candidates.json ausente");
		try {
			return (
				parseCandidates(JSON.parse(artifact.content), [
					...config.watchdogIds,
					GENERAL_WATCHDOG_ID,
				]) ?? JevCandidatesStore.unavailable("candidates.json inválido")
			);
		} catch {
			return JevCandidatesStore.unavailable("candidates.json inválido");
		}
	}

	/** Resumo do contexto persistido (usado quando o staging já foi limpo). */
	contextSummary(): ContextSummary | null {
		const artifact = this.storage.readArtifact(
			this.review.id,
			"context-summary.json",
		);
		if (!artifact) return null;
		try {
			return parseContextSummary(JSON.parse(artifact.content));
		} catch {
			return null;
		}
	}

	/** Modelo de intenção persistido pelo prepare/revisor; `null` quando ausente. */
	businessSummary(): BusinessSummary | null {
		const raw = this.json<unknown>(BUSINESS_SUMMARY_FILE);
		return raw ? parseBusinessSummary(raw) : null;
	}

	/** Pontos técnicos persistidos pelo `prepare`; `null` quando ausentes. */
	technicalSummary(): TechnicalSummary | null {
		const raw = this.json<unknown>(TECHNICAL_SUMMARY_FILE);
		return raw ? parseTechnicalSummary(raw) : null;
	}

	/** Fallback para runs antigas: reconstrói os destaques dos artefatos de AST. */
	technicalFallback(classification: RunClassification): TechnicalSummary {
		const ast = this.json<{ files?: Record<string, AstAnalysis> }>(
			"ast-summary.json",
		);
		return buildTechnicalSummary({
			classification,
			ast: ast?.files ? new Map(Object.entries(ast.files)) : undefined,
			impact: this.json<AstImpact>("ast-impact.json") ?? undefined,
			headSha: classification.headSha,
		});
	}

	/** Persiste o contexto da PR (bruto + resumo) como artefatos, quando existirem. */
	persistContext(): void {
		const raw = this.work.readContextRaw();
		if (raw !== null) {
			this.storage.writeArtifact(this.review.id, {
				name: "context.json",
				kind: "context",
				content: raw,
			});
		}
		const summary = this.work.readContextSummaryRaw();
		if (summary !== null) {
			this.storage.writeArtifact(this.review.id, {
				name: "context-summary.json",
				kind: "context-summary",
				content: summary,
			});
		}
		const brief = this.work.readContextBriefRaw();
		if (brief !== null) {
			this.storage.writeArtifact(this.review.id, {
				name: "context-brief.md",
				kind: "context-brief",
				content: brief,
			});
		}
	}

	/**
	 * Persiste o `business-summary.json` final: o revisor `general` pode ter
	 * reescrito o modelo no staging durante a revisão.
	 */
	persistBusiness(): BusinessSummary | null {
		const raw = this.work.readBusinessSummaryRaw();
		if (raw === null) return this.businessSummary();
		this.storage.writeArtifact(this.review.id, {
			name: BUSINESS_SUMMARY_FILE,
			kind: "business",
			content: raw.endsWith("\n") ? raw : `${raw}\n`,
		});
		const brief = this.work.readBusinessBriefRaw();
		if (brief !== null) {
			this.storage.writeArtifact(this.review.id, {
				name: BUSINESS_BRIEF_FILE,
				kind: "business-brief",
				content: brief.endsWith("\n") ? brief : `${brief}\n`,
			});
		}
		try {
			return parseBusinessSummary(JSON.parse(raw), "reviewer");
		} catch {
			return this.businessSummary();
		}
	}
}
