/**
 * Candidatos a achado produzidos pelo passo de pré-análise Jev (Passo 1.5).
 *
 * Um candidato NÃO é um achado: é um indício com confiança calibrada, injetado
 * nos briefs para o subagente **confirmar ou refutar**. A severidade/validação
 * final continua sendo do revisor (LLM) ou humano.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SEVERITY_ORDER, type Severity } from "../types";

export type JevCandidate = {
	reviewerId: string;
	/** Descrição da regra (deve ser usada como `rule` se confirmada). */
	rule: string;
	severity: Severity;
	file: string;
	/** Probabilidade calibrada retornada pelo modelo (0–1). */
	confidence: number;
	/** Chave da pergunta que originou o candidato. */
	questionKey: string;
};

export type JevSkippedFile = { file: string; reason: string };

export type JevCandidatesFile = {
	available: boolean;
	/** Motivo quando `available: false` (sem chave, erro, etc.). */
	reason?: string;
	model?: string;
	threshold?: number;
	analyzedFiles?: number;
	candidates: JevCandidate[];
	skipped?: JevSkippedFile[];
};

const SEVERITY_SET = new Set<string>(SEVERITY_ORDER);

/** Persistência do artefato `candidates.json` para um diretório de review. */
export class JevCandidatesStore {
	/** Limiar padrão de confiança (`noul`) para virar candidato. */
	static readonly THRESHOLD = 0.6;

	/** Artefato vazio/indisponível (sem chave, erro, `--no-jev`). */
	static unavailable(reason: string): JevCandidatesFile {
		return { available: false, reason, candidates: [] };
	}

	private readonly filePath: string;
	/** Ids válidos (null = sem filtro por id). */
	private readonly reviewerIdSet: Set<string> | null;

	constructor(filePath: string, validIds: readonly string[] = []) {
		this.filePath = filePath;
		this.reviewerIdSet = validIds.length > 0 ? new Set(validIds) : null;
	}

	/** Grava o `candidates.json` (sempre com candidatos válidos apenas). */
	write(data: JevCandidatesFile): void {
		writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
	}

	/** Lê o `candidates.json`; null se ausente/inválido. */
	read(): JevCandidatesFile | null {
		if (!existsSync(this.filePath)) return null;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
				string,
				unknown
			>;
			const candidates = Array.isArray(raw.candidates)
				? raw.candidates.filter((c) => this.isCandidate(c))
				: [];
			return {
				available: raw.available === true,
				reason: typeof raw.reason === "string" ? raw.reason : undefined,
				model: typeof raw.model === "string" ? raw.model : undefined,
				threshold: typeof raw.threshold === "number" ? raw.threshold : undefined,
				analyzedFiles:
					typeof raw.analyzedFiles === "number" ? raw.analyzedFiles : undefined,
				candidates,
				skipped: Array.isArray(raw.skipped)
					? (raw.skipped as JevSkippedFile[])
					: undefined,
			};
		} catch {
			return null;
		}
	}

	private isCandidate(value: unknown): value is JevCandidate {
		if (typeof value !== "object" || value === null) return false;
		const c = value as Record<string, unknown>;
		return (
			typeof c.reviewerId === "string" &&
			(this.reviewerIdSet === null || this.reviewerIdSet.has(c.reviewerId)) &&
			typeof c.rule === "string" &&
			typeof c.severity === "string" &&
			SEVERITY_SET.has(c.severity) &&
			typeof c.file === "string" &&
			typeof c.confidence === "number" &&
			typeof c.questionKey === "string"
		);
	}
}
