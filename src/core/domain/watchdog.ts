/**
 * Watchdog (domínio) — envolve a definição declarativa do projeto.
 *
 * A configuração continua sendo um objeto plano (`WatchdogDefinition`); esta
 * classe concentra o comportamento (casar arquivo, ordenar regras, contexto e
 * render do brief) sem alterar o contrato do consumidor.
 */

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

/** `true` se o arquivo casa a entrada de classificação. */
export function matchesClassifyRule(
	filePath: string,
	rule: ClassifyRule,
	content: string | undefined,
): boolean {
	if ((rule.type ?? DEFAULT_CLASSIFY_TYPE) === "content") {
		return content !== undefined && new RegExp(rule.value).test(content);
	}
	return new RegExp(rule.value).test(filePath);
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
	matches(filePath: string, content?: string): boolean {
		return this.classify.some((rule) => matchesClassifyRule(filePath, rule, content));
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
