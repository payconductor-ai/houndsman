/**
 * Candidatos a achado produzidos pelo passo de pré-análise Jev (Passo 1.5).
 *
 * Um candidato NÃO é um achado: é um indício com confiança calibrada, injetado
 * nos briefs para o subagente **confirmar ou refutar**. A severidade/validação
 * final continua sendo do watchdog (LLM) ou humano.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SEVERITY_ORDER, type Severity } from "../types";

export type JevCandidate = {
	watchdogId: string;
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

/** Serializa o artefato `candidates.json` (sempre com quebra de linha final). */
export function serializeCandidates(data: JevCandidatesFile): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

/** Valida/parseia o JSON bruto do artefato; null se inválido. */
export function parseCandidates(
	raw: unknown,
	validIds: readonly string[] = [],
): JevCandidatesFile | null {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw as Record<string, unknown>;
	const idSet = validIds.length > 0 ? new Set(validIds) : null;
	const isCandidate = (entry: unknown): entry is JevCandidate => {
		if (typeof entry !== "object" || entry === null) return false;
		const c = entry as Record<string, unknown>;
		return (
			typeof c.watchdogId === "string" &&
			(idSet === null || idSet.has(c.watchdogId)) &&
			typeof c.rule === "string" &&
			typeof c.severity === "string" &&
			SEVERITY_SET.has(c.severity) &&
			typeof c.file === "string" &&
			typeof c.confidence === "number" &&
			typeof c.questionKey === "string"
		);
	};
	const candidates = Array.isArray(value.candidates)
		? value.candidates.filter(isCandidate)
		: [];
	return {
		available: value.available === true,
		reason: typeof value.reason === "string" ? value.reason : undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		threshold: typeof value.threshold === "number" ? value.threshold : undefined,
		analyzedFiles:
			typeof value.analyzedFiles === "number" ? value.analyzedFiles : undefined,
		candidates,
		skipped: Array.isArray(value.skipped)
			? (value.skipped as JevSkippedFile[])
			: undefined,
	};
}

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
	private readonly watchdogIdSet: Set<string> | null;

	constructor(filePath: string, validIds: readonly string[] = []) {
		this.filePath = filePath;
		this.watchdogIdSet = validIds.length > 0 ? new Set(validIds) : null;
	}

	/** Grava o `candidates.json` (sempre com candidatos válidos apenas). */
	write(data: JevCandidatesFile): void {
		writeFileSync(this.filePath, serializeCandidates(data));
	}

	/** Lê o `candidates.json`; null se ausente/inválido. */
	read(): JevCandidatesFile | null {
		if (!existsSync(this.filePath)) return null;
		try {
			return parseCandidates(
				JSON.parse(readFileSync(this.filePath, "utf8")),
				this.watchdogIdSet ? [...this.watchdogIdSet] : [],
			);
		} catch {
			return null;
		}
	}
}
