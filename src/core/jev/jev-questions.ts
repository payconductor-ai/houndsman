/**
 * Deriva perguntas Jev (tipadas) a partir das regras do `REVIEWER_DEFINITIONS`.
 *
 * Fonte única de verdade: o registry. Uma regra só gera pergunta se tiver a
 * spec Jev (campo opcional `jev` de `Rule`). Assim não há lista paralela para
 * sincronizar — alterar a regra no registry altera a pergunta.
 */

import type { ReviewerMeta, Rule, Severity } from "../types";
import type { JevQuestion, JevRuleSpec } from "./jev-types";

export type DerivedQuestion = {
	/** Chave estável da pergunta (`<reviewerId>::<bucket>-<índice>`). */
	key: string;
	reviewerId: string;
	severity: Severity;
	/** Descrição original da regra (usada como `rule` no achado confirmado). */
	rule: string;
	question: JevQuestion;
};

/**
 * Converte regras do registry em perguntas tipadas para a API.
 *
 * Encapsula toda a lógica de conversão/derivação. O registry (revisores) é
 * injetado via `ReviewConfig`, permitindo testes sem tocar no registry real.
 */
export class JevQuestionFactory {
	private readonly registry: Record<string, ReviewerMeta>;

	constructor(registry: Record<string, ReviewerMeta>) {
		this.registry = registry;
	}

	/** Converte uma `JevRuleSpec` em `JevQuestion`; null se a spec for inválida. */
	fromSpec(description: string, spec: JevRuleSpec): JevQuestion | null {
		const instructions = (spec.instructions ?? this.noul(description)).trim();
		if (!instructions) return null;

		if (spec.kind === "noul") return { type: "noul", instructions };

		if (spec.kind === "choice") {
			const criteria = spec.criteria;
			if (!criteria || Array.isArray(criteria)) return null;
			if (Object.keys(criteria).length === 0) return null;
			return { type: "choice", instructions, criteria };
		}

		// score
		if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) return null;
		return { type: "score", instructions, criteria: spec.criteria };
	}

	/** Perguntas derivadas das regras de um revisor (`rules`). */
	derive(reviewerId: string): DerivedQuestion[] {
		const meta = this.registry[reviewerId];
		if (!meta) return [];

		const out: DerivedQuestion[] = [];
		meta.rules.forEach((rule, index) => {
			const spec = this.specOf(rule);
			if (!spec) return;
			const question = this.fromSpec(rule.text, spec);
			if (!question) return;
			out.push({
				key: `${reviewerId}::rule-${index}`,
				reviewerId,
				severity: rule.severity,
				rule: rule.text,
				question,
			});
		});
		return out;
	}

	/** Perguntas derivadas para um conjunto de revisores. */
	build(reviewerIds: readonly string[]): DerivedQuestion[] {
		return reviewerIds.flatMap((id) => this.derive(id));
	}

	/**
	 * Acesso tipado à spec Jev da regra (campo opcional `jev`).
	 */
	specOf(rule: Rule): JevRuleSpec | undefined {
		return rule.jev;
	}

	/** Instrução padrão quando a spec não traz `instructions`. */
	private noul(description: string): string {
		return `No estado fornecido, ocorre a seguinte violação? "${description}"`;
	}
}
