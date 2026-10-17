/**
 * Verificação de findings (biblioteca) — "as violações foram resolvidas?".
 *
 * Checagem barata, **sem re-revisar a PR**:
 *  - Tier 0 (local, grátis): reancora a âncora de conteúdo contra o working tree.
 *  - Tier 1 (Jev, opcional): confirma/refuta os casos ambíguos (âncora sumida ou
 *    inexistente) via LLM, sobre um diff focado do arquivo (`jev-verify.ts`).
 *
 * `verifyLocal` é puro (recebe o leitor de arquivos); o comando renderiza e, com
 * `--apply`, persiste `resolved` → `execState: done`.
 */

import { reanchor } from "./finding-anchor";
import {
	applyFindingUpdate,
	type FileReader,
	type FindingState,
	type FindingsFilter,
	type FindingsStateFile,
	filterFindings,
} from "./findings-state";
import { systemClock } from "./services/clock";
import type { Severity } from "./types";

/** Resultado da verificação de um finding. */
export type VerifyStatus = "resolved" | "persisting" | "uncertain" | "file-missing";

/** Mecanismo que decidiu o status (reancoragem local, Jev ou IA). */
export type VerifyBasis = "anchor" | "jev" | "ai";

/** Valores canônicos de status (ordem de exibição). */
export const VERIFY_STATUSES: readonly VerifyStatus[] = [
	"resolved",
	"persisting",
	"uncertain",
	"file-missing",
];

/** Um finding verificado. */
export type VerifyEntry = {
	id: string;
	file: string;
	rule: string;
	severity: Severity;
	message: string;
	line: number | null;
	status: VerifyStatus;
	basis: VerifyBasis;
	/** Confiança do Jev (0–1) quando `basis: "jev"`. */
	confidence?: number;
	detail?: string;
	/** Ambíguo no tier local — candidato à confirmação do Jev. */
	ambiguous: boolean;
};

/** Fila de verificação: presentes, excluindo `ignore` (descartados pelo usuário). */
export function selectVerifiable(
	state: FindingsStateFile,
	filter: FindingsFilter = {},
): FindingState[] {
	return filterFindings(state, filter).filter(
		(finding) => finding.decision !== "ignore",
	);
}

/**
 * Tier 0 — checagem local por conteúdo. Marca `ambiguous: true` quando a âncora
 * sumiu (corrigida ou trecho reescrito) ou não existe; nesses casos o Jev pode
 * confirmar. Âncora presente (`ok`/`moved`) ⇒ `persisting`, definitivo.
 */
export function verifyLocal(
	findings: readonly FindingState[],
	readFile: FileReader,
): VerifyEntry[] {
	return findings.map((finding) => {
		const base = {
			id: finding.id,
			file: finding.file,
			rule: finding.rule,
			severity: finding.severity,
			message: finding.message,
			line: finding.line,
		};
		const content = readFile(finding.file);
		if (content === null) {
			return {
				...base,
				status: "file-missing" as const,
				basis: "anchor" as const,
				ambiguous: false,
				detail: "arquivo ausente no working tree",
			};
		}
		if (!finding.anchor) {
			return {
				...base,
				status: "uncertain" as const,
				basis: "anchor" as const,
				ambiguous: true,
				detail: "finding sem âncora de conteúdo",
			};
		}
		const { status } = reanchor(content, finding.anchor, finding.line);
		if (status === "stale") {
			return {
				...base,
				status: "resolved" as const,
				basis: "anchor" as const,
				ambiguous: true,
				detail: "âncora ausente (trecho corrigido?)",
			};
		}
		return {
			...base,
			status: "persisting" as const,
			basis: "anchor" as const,
			ambiguous: false,
			detail: status === "moved" ? "âncora deslocada" : undefined,
		};
	});
}

/**
 * Tier 1 genérico — aplica confirmações externas (Jev ou IA) aos casos ambíguos.
 * `confidence[id] >= threshold` ⇒ a violação persiste; abaixo ⇒ resolvida.
 * Ids sem resposta mantêm o provisório local (fail-open). Devolve o nº aplicado.
 *
 * `basis` identifica a fonte da decisão (`jev` ou `ai`).
 */
export function applyConfidence(
	entries: VerifyEntry[],
	confidence: Map<string, number>,
	threshold: number,
	basis: VerifyBasis = "jev",
): number {
	let applied = 0;
	for (const entry of entries) {
		if (!entry.ambiguous) continue;
		const value = confidence.get(entry.id);
		if (value === undefined) continue;
		entry.basis = basis;
		entry.confidence = value;
		entry.status = value >= threshold ? "persisting" : "resolved";
		applied++;
	}
	return applied;
}

/** Compatibilidade: confirmação via Jev. */
export function applyJev(
	entries: VerifyEntry[],
	confidence: Map<string, number>,
	threshold: number,
): number {
	return applyConfidence(entries, confidence, threshold, "jev");
}

export type VerifySummary = Record<VerifyStatus, number>;

/** Contagem por status. */
export function summarizeVerify(entries: readonly VerifyEntry[]): VerifySummary {
	const summary = Object.fromEntries(
		VERIFY_STATUSES.map((status) => [status, 0]),
	) as VerifySummary;
	for (const entry of entries) summary[entry.status]++;
	return summary;
}

/**
 * Persiste os `resolved` como `done` (acao `verify`). Devolve os ids alterados.
 * Muta o estado em memória (o caller persiste).
 */
export function applyResolutions(
	state: FindingsStateFile,
	entries: readonly VerifyEntry[],
	now: string = systemClock(),
): string[] {
	const changed: string[] = [];
	for (const entry of entries) {
		if (entry.status !== "resolved") continue;
		const finding = state.findings[entry.id];
		if (!finding || finding.execState === "done") continue;
		applyFindingUpdate(finding, { execState: "done", by: "verify" }, now);
		changed.push(finding.id);
	}
	if (changed.length > 0) state.updatedAt = now;
	return changed;
}
