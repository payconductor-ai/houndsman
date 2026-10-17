/**
 * Crítico de findings (`FindingCritic`).
 *
 * Segunda passada com o objetivo de **refutar** cada draft. Regras:
 *  - sem evidência válida → drop;
 *  - regra inexistente → drop;
 *  - confiança baixa → downgrade; muito baixa → drop;
 *  - `blocking`/`attention` exigem crítica (determinística aqui; um crítico
 *    por IA pode ser injetado no futuro).
 */

import { emergentText, isEmergentRule } from "../../core/rule-text";
import { type Severity, severityRank } from "../../core/types";
import type { AgentState } from "./agent-state";
import type { CriticDecision, FindingDraft } from "./evidence";
import type { EvidenceVerifier } from "./evidence-verifier";

/** Regras válidas do watchdog (texto). */
export type CriticOptions = {
	knownRules: ReadonlySet<string>;
	verifier: EvidenceVerifier;
	/** Aceita findings `Lógica:`/`Domínio:` fora das regras. */
	allowEmergentFindings?: boolean;
};

/** Crítico determinístico. */
export class FindingCritic {
	private readonly options: CriticOptions;

	constructor(options: CriticOptions) {
		this.options = options;
	}

	/** Avalia todos os drafts, na ordem. */
	review(drafts: readonly FindingDraft[], state: AgentState): CriticDecision[] {
		return drafts.map((draft) => this.reviewOne(draft, state));
	}

	/** Avalia um draft. */
	reviewOne(draft: FindingDraft, state: AgentState): CriticDecision {
		const known = this.options.knownRules.has(draft.rule.trim());
		const emergent = isEmergentRule(draft.rule);
		if (!known && !(emergent && this.options.allowEmergentFindings)) {
			return {
				draft,
				verdict: "drop",
				reason: emergent
					? "finding emergente desabilitado no watchdog"
					: "regra não existe no watchdog",
			};
		}
		if (emergent && !emergentText(draft.rule)) {
			return { draft, verdict: "drop", reason: "finding emergente sem descrição" };
		}
		const verdict = this.options.verifier.verifyDraft(draft, state);
		if (!verdict.valid) {
			return { draft, verdict: "drop", reason: verdict.reason ?? "sem evidência" };
		}
		if (draft.confidence < 0.4) {
			return { draft, verdict: "drop", reason: "confiança abaixo de 0.4" };
		}
		const normalized = emergent
			? { ...draft, severity: capSeverity(draft.severity, "attention") }
			: draft;
		if (
			normalized.confidence < 0.7 &&
			(normalized.severity === "blocking" || normalized.severity === "attention")
		) {
			return {
				draft: normalized,
				verdict: "downgrade",
				reason: "confiança insuficiente para a severidade",
			};
		}
		return { draft: normalized, verdict: "keep", reason: "evidência válida" };
	}
}

/** Limita a severidade a um teto (rank menor = mais grave). */
export function capSeverity(severity: Severity, max: Severity): Severity {
	return severityRank(severity) < severityRank(max) ? max : severity;
}

/** Rebaixa uma severidade em um nível. */
export function downgrade(severity: Severity): Severity {
	switch (severity) {
		case "blocking":
			return "attention";
		case "attention":
			return "suggestion";
		case "suggestion":
			return "nit";
		default:
			return "nit";
	}
}
