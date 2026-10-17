/**
 * Watchdog (domínio) — envolve a definição declarativa do projeto.
 *
 * A configuração continua sendo um objeto plano (`WatchdogDefinition`); esta
 * classe concentra o comportamento (casar arquivo, ordenar regras, contexto e
 * render do brief) sem alterar o contrato do consumidor.
 */

import type { AstFacts } from "../ast/types";
import { renderBrief } from "../brief";
import {
	type ClassifyRule,
	type Rule,
	severityRank,
	type WatchdogDefinition,
	type WatchdogRenderArgs,
} from "../types";

/** Tipo assumido quando `type` é omitido. */
const DEFAULT_CLASSIFY_TYPE: NonNullable<ClassifyRule["type"]> = "filename";

/** `true` se algum valor do conjunto casa o padrão. */
function matchesAny(values: readonly string[], pattern: RegExp): boolean {
	return values.some((value) => pattern.test(value));
}

/** `true` se o arquivo casa a entrada de classificação. */
export function matchesClassifyRule(
	filePath: string,
	rule: ClassifyRule,
	content: string | undefined,
	facts?: AstFacts,
): boolean {
	const pattern = new RegExp(rule.value);
	switch (rule.type ?? DEFAULT_CLASSIFY_TYPE) {
		case "content":
			return content !== undefined && pattern.test(content);
		case "symbol":
			return (
				facts !== undefined &&
				matchesAny(
					facts.symbols.flatMap((symbol) => [symbol.name, symbol.kind]),
					pattern,
				)
			);
		case "import":
			return (
				facts !== undefined &&
				matchesAny(
					facts.imports.flatMap((item) => [item.source, ...item.names]),
					pattern,
				)
			);
		case "export":
			return (
				facts !== undefined &&
				matchesAny(
					facts.exports.map((item) => item.name),
					pattern,
				)
			);
		case "decorator":
			return facts !== undefined && matchesAny(facts.decorators, pattern);
		default:
			return pattern.test(filePath);
	}
}

/** Contexto "essencial" do watchdog — SEM regras (docs/UI/inspeção). */
export type WatchdogContext = {
	id: string;
	name: string;
	description: string;
	scope: string;
	reviewFocus?: readonly string[];
	exclude?: readonly string[];
	contextFiles: string[];
};

/** Comportamento de um watchdog do projeto. */
export class Watchdog {
	readonly definition: WatchdogDefinition;

	constructor(definition: WatchdogDefinition) {
		this.definition = definition;
	}

	get id(): string {
		return this.definition.id;
	}

	get name(): string {
		return this.definition.name;
	}

	get description(): string {
		return this.definition.description;
	}

	get scope(): string {
		return this.definition.scope;
	}

	/** Regras de classificação declaradas (vazio = não casa nenhum arquivo). */
	get classify(): readonly ClassifyRule[] {
		return this.definition.classify ?? [];
	}

	/** `true` se o arquivo é deste domínio. */
	matches(filePath: string, content?: string, facts?: AstFacts): boolean {
		return this.classify.some((rule) =>
			matchesClassifyRule(filePath, rule, content, facts),
		);
	}

	/** Regras ordenadas por severidade (mais grave primeiro). */
	get rules(): readonly Rule[] {
		return [...this.definition.rules].sort(
			(a, b) => severityRank(a.severity) - severityRank(b.severity),
		);
	}

	/** Metadados sem as regras. */
	context(): WatchdogContext {
		const { id, name, description, scope, reviewFocus, exclude, contextFiles } =
			this.definition;
		return { id, name, description, scope, reviewFocus, exclude, contextFiles };
	}

	/** Render do brief (hook custom ou default). */
	renderBrief(args: WatchdogRenderArgs): string {
		return renderBrief(this.definition, args);
	}
}
