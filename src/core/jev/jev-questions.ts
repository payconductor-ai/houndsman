/**
 * Deriva perguntas Jev (tipadas) a partir das regras do `REVIEWER_DEFINITIONS`.
 *
 * Fonte única de verdade: o registry. Uma regra só gera pergunta se tiver a
 * spec Jev (terceiro elemento da tupla `Rule`). Assim não há lista paralela
 * para sincronizar — alterar a regra no registry altera a pergunta.
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
		if (spec === true) {
			return { type: "noul", instructions: this.noul(description) };
		}
		if (typeof spec === "string") {
			const instructions = spec.trim();
			return instructions ? { type: "noul", instructions } : null;
		}

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

	/** Perguntas derivadas das regras de um revisor (criticalRules + antiPatterns). */
	derive(reviewerId: string): DerivedQuestion[] {
		const meta = this.registry[reviewerId];
		if (!meta) return [];
		const buckets: [string, readonly Rule[]][] = [
			["crit", meta.criticalRules],
			["anti", meta.antiPatterns],
		];

		const out: DerivedQuestion[] = [];
		for (const [bucket, rules] of buckets) {
			rules.forEach((rule, index) => {
				const spec = this.specOf(rule);
				if (!spec) return;
				const [severity, description] = rule;
				const question = this.fromSpec(description, spec);
				if (!question) return;
				out.push({
					key: `${reviewerId}::${bucket}-${index}`,
					reviewerId,
					severity,
					rule: description,
					question,
				});
			});
		}
		return out;
	}

	/** Perguntas derivadas para um conjunto de revisores. */
	build(reviewerIds: readonly string[]): DerivedQuestion[] {
		return reviewerIds.flatMap((id) => this.derive(id));
	}

	/**
	 * Acesso tipado à spec Jev (terceiro elemento opcional da tupla `Rule`).
	 *
	 * A anotação explícita da largura (`Rule` é `readonly [Severity, string, JevRuleSpec?]`)
	 * torna o acesso independente da aridade inferida da tupla no consumidor.
	 */
	specOf(rule: Rule): JevRuleSpec | undefined {
		const tuple: readonly [Severity, string, JevRuleSpec?] = rule;
		return tuple[2];
	}

	/** Instrução padrão para specs `true` (regras redigidas como violação). */
	private noul(description: string): string {
		return `No estado fornecido, ocorre a seguinte violação? "${description}"`;
	}
}
