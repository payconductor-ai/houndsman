/**
 * Verificador de evidências (`EvidenceVerifier`).
 *
 * Confere arquivo/linha/snippet contra o working tree. Evidência inválida não
 * sustenta finding: o draft é descartado (ou reancorado quando o snippet existe
 * em outra linha).
 */

import { normalizeLine } from "../../core/finding-anchor";
import type { AgentState } from "./agent-state";
import type { Evidence, FindingDraft } from "./evidence";

/** Resultado da verificação de uma evidência. */
export type EvidenceVerdict = {
	evidence: Evidence;
	valid: boolean;
	reason?: string;
	/** Linhas corrigidas quando o snippet foi reancorado. */
	startLine?: number;
	endLine?: number;
};

/** Resultado da verificação de um draft. */
export type DraftVerdict = {
	draft: FindingDraft;
	valid: boolean;
	evidence: Evidence[];
	reason?: string;
};

/** Verificador de evidências por conteúdo. */
export class EvidenceVerifier {
	private readonly allowedFiles: ReadonlySet<string>;
	private readonly readFile: (path: string) => string | null;

	constructor(options: {
		allowedFiles: Iterable<string>;
		readFile: (path: string) => string | null;
	}) {
		this.allowedFiles = new Set(options.allowedFiles);
		this.readFile = options.readFile;
	}

	/** Verifica uma evidência (arquivo permitido + snippet localizado). */
	verify(evidence: Evidence): EvidenceVerdict {
		if (!this.allowedFiles.has(evidence.file)) {
			return { evidence, valid: false, reason: "arquivo fora do domínio/impacto" };
		}
		const content = this.readFile(evidence.file);
		if (content === null) {
			return { evidence, valid: false, reason: "arquivo ausente" };
		}
		const lines = content.replace(/\r\n/g, "\n").split("\n");
		const expected = evidence.snippet
			.split("\n")
			.map(normalizeLine)
			.filter((line) => line.length > 0);
		if (expected.length === 0) {
			return { evidence, valid: false, reason: "snippet vazio" };
		}

		const start = Math.max(1, evidence.startLine);
		const actual = lines
			.slice(start - 1, start - 1 + expected.length)
			.map(normalizeLine);
		if (sameLines(actual, expected)) {
			return {
				evidence,
				valid: true,
				startLine: start,
				endLine: start + expected.length - 1,
			};
		}

		const relocated = lines.findIndex((_line, index) =>
			sameLines(
				lines.slice(index, index + expected.length).map(normalizeLine),
				expected,
			),
		);
		if (relocated >= 0) {
			return {
				evidence,
				valid: true,
				reason: "reancorado",
				startLine: relocated + 1,
				endLine: relocated + expected.length,
			};
		}
		return { evidence, valid: false, reason: "snippet não encontrado no arquivo" };
	}

	/** Verifica um draft: precisa de ao menos uma evidência válida. */
	verifyDraft(draft: FindingDraft, state: AgentState): DraftVerdict {
		const evidence: Evidence[] = [];
		const reasons: string[] = [];
		for (const id of draft.evidenceIds) {
			const item = state.getEvidence(id);
			if (!item) {
				reasons.push(`evidência '${id}' inexistente`);
				continue;
			}
			const verdict = this.verify(item);
			if (verdict.valid) {
				evidence.push({
					...item,
					startLine: verdict.startLine ?? item.startLine,
					endLine: verdict.endLine ?? item.endLine,
				});
			} else {
				reasons.push(verdict.reason ?? "evidência inválida");
			}
		}
		return {
			draft,
			valid: evidence.length > 0,
			evidence,
			...(evidence.length === 0
				? { reason: reasons.join("; ") || "sem evidência" }
				: {}),
		};
	}
}

/** Compara linhas normalizadas. */
function sameLines(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((line, index) => line === b[index]);
}
