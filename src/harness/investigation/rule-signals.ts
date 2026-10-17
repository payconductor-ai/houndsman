/**
 * Extração determinística de sinais de uma regra em linguagem natural.
 *
 * Cada extrator é substituível (`RuleSignalExtractor`); o default usa `hints`
 * + termos em backticks + identificadores. Nunca chama IA.
 */

import type { Rule } from "../../core/types";

/** Sinal concreto sugerido por uma regra. */
export type RuleSignal = {
	kind: "symbol" | "import" | "decorator" | "path" | "grep" | "ast";
	value: string;
	rationale?: string;
};

/** Contrato de um extrator de sinais. */
export interface RuleSignalExtractor {
	extract(rule: Rule): RuleSignal[];
}

/** Extrai sinais dos `hints`, backticks e identificadores em CamelCase. */
export class HeuristicRuleSignalExtractor implements RuleSignalExtractor {
	extract(rule: Rule): RuleSignal[] {
		const signals: RuleSignal[] = [];
		const seen = new Set<string>();
		const push = (kind: RuleSignal["kind"], value: string, rationale?: string) => {
			const key = `${kind}:${value}`;
			if (!value.trim() || seen.has(key)) return;
			seen.add(key);
			signals.push({ kind, value, ...(rationale ? { rationale } : {}) });
		};

		const hints = rule.hints ?? {};
		for (const item of hints.symbols ?? []) push("symbol", item, "hint");
		for (const item of hints.imports ?? []) push("import", item, "hint");
		for (const item of hints.decorators ?? []) push("decorator", item, "hint");
		for (const item of hints.paths ?? []) push("path", item, "hint");

		for (const match of rule.text.matchAll(/`([^`]{2,80})`/g)) {
			const value = match[1]?.trim();
			if (value) push(classifyLiteral(value), value, "texto da regra");
		}
		for (const match of rule.text.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\b/g)) {
			push("symbol", match[1] ?? "", "identificador");
		}
		return signals;
	}
}

/** Classifica um literal em backticks (import, path, símbolo). */
function classifyLiteral(value: string): RuleSignal["kind"] {
	if (value.startsWith("@") || value.includes("/")) {
		return value.includes("/") && !value.includes("@") ? "path" : "import";
	}
	if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) return "symbol";
	return "grep";
}

/** Gera checks concretos para uma regra. */
export interface RuleCheckFactory {
	create(rule: Rule, signals: readonly RuleSignal[]): RuleCheck[];
}

/** Check que prova/refuta uma regra usando uma tool. */
export type RuleCheck = {
	id: string;
	description: string;
	tool: string;
	input: unknown;
	required: boolean;
};

/** Checks default por presença de sinais. */
export class DefaultRuleCheckFactory implements RuleCheckFactory {
	create(rule: Rule, signals: readonly RuleSignal[]): RuleCheck[] {
		const checks: RuleCheck[] = [];
		const explicit = rule.hints?.checks ?? [];
		explicit.forEach((tool, index) => {
			checks.push({
				id: `${index}:${tool}`,
				description: `Executar ${tool} para a regra`,
				tool,
				input: {},
				required: true,
			});
		});
		const symbols = signals.filter((signal) => signal.kind === "symbol");
		if (symbols.length > 0 && explicit.length === 0) {
			checks.push({
				id: "symbol-context",
				description: `Inspecionar o contexto de ${symbols[0]?.value}`,
				tool: "symbol_context",
				input: { symbol: symbols[0]?.value },
				required: false,
			});
		}
		const imports = signals.filter((signal) => signal.kind === "import");
		if (imports.length > 0) {
			checks.push({
				id: "find-references",
				description: `Procurar usos de ${imports[0]?.value}`,
				tool: "find_references",
				input: { symbol: imports[0]?.value },
				required: false,
			});
		}
		return checks;
	}
}
