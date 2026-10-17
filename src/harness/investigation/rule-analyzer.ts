/**
 * Análise determinística de regras (`RuleAnalyzer`).
 *
 * Transforma uma regra textual em polaridade, categoria, keywords, sinais e
 * checks. É a base do planner e do `rule_signals` tool. Um analyzer por IA pode
 * complementar regras ambíguas, mas o resultado continua validado.
 */

import { POLARITY_WORDS, polarityOf, type RuleIntent } from "../../core/rule-text";
import type { Rule, Severity } from "../../core/types";
import {
	DefaultRuleCheckFactory,
	HeuristicRuleSignalExtractor,
	type RuleCheck,
	type RuleCheckFactory,
	type RuleSignal,
	type RuleSignalExtractor,
} from "./rule-signals";

export { polarityOf, type RuleIntent } from "../../core/rule-text";

/** Categoria da regra. */
export type RuleCategory =
	| "architecture"
	| "security"
	| "data"
	| "tests"
	| "performance"
	| "style"
	| "other";

/** Regra analisada (entrada do planner). */
export type RuleAnalysis = {
	rule: string;
	severity: Severity;
	intent: RuleIntent;
	category: RuleCategory;
	keywords: string[];
	signals: RuleSignal[];
	checks: RuleCheck[];
	confidence: "high" | "medium" | "low";
};

const GENERIC_STOPWORDS = [
	"para",
	"pelo",
	"pela",
	"como",
	"ser",
	"que",
	"com",
	"sem",
	"uma",
	"dos",
	"das",
	"nos",
	"nas",
	"por",
	"usar",
	"todo",
	"toda",
	"quando",
	"onde",
] as const;

/** Stopwords + palavras de polaridade (fonte única em `core/rule-text`). */
const STOPWORDS = new Set<string>([...GENERIC_STOPWORDS, ...POLARITY_WORDS]);

const CATEGORY_HINTS: readonly [RuleCategory, readonly string[]][] = [
	[
		"security",
		[
			"segredo",
			"senha",
			"token",
			"auth",
			"sanit",
			"injection",
			"sql",
			"cripto",
			"permiss",
		],
	],
	["data", ["banco", "database", "db", "query", "migration", "schema", "transa"]],
	["tests", ["teste", "test", "spec", "cobertura", "mock", "fixture"]],
	[
		"performance",
		["cache", "performance", "latência", "latencia", "n+1", "índice", "indice"],
	],
	[
		"architecture",
		[
			"camada",
			"arquitetura",
			"rota",
			"controller",
			"service",
			"domínio",
			"dominio",
			"depend",
		],
	],
	["style", ["nome", "formata", "lint", "coment", "estilo", "padrão", "padrao"]],
];

/** Analisador determinístico. */
export class RuleAnalyzer {
	private readonly extractor: RuleSignalExtractor;
	private readonly checks: RuleCheckFactory;

	constructor(
		extractor: RuleSignalExtractor = new HeuristicRuleSignalExtractor(),
		checks: RuleCheckFactory = new DefaultRuleCheckFactory(),
	) {
		this.extractor = extractor;
		this.checks = checks;
	}

	/** Analisa todas as regras (ordem estável). */
	analyze(rules: readonly Rule[]): RuleAnalysis[] {
		return rules.map((rule) => this.analyzeRule(rule));
	}

	/** Analisa uma regra. */
	analyzeRule(rule: Rule): RuleAnalysis {
		const intent = polarityOf(rule.text);
		const signals = this.extractor.extract(rule);
		const category = categoryOf(rule.text, signals);
		const confidence = confidenceOf(rule, signals);
		return {
			rule: rule.text,
			severity: rule.severity,
			intent,
			category,
			keywords: keywordsOf(rule.text),
			signals,
			checks: this.checks.create(rule, signals),
			confidence,
		};
	}
}

/** Categoria inferida por keywords e sinais. */
export function categoryOf(text: string, signals: readonly RuleSignal[]): RuleCategory {
	const haystack =
		`${text} ${signals.map((signal) => signal.value).join(" ")}`.toLowerCase();
	for (const [category, hints] of CATEGORY_HINTS) {
		if (hints.some((hint) => haystack.includes(hint))) return category;
	}
	return "other";
}

/** Keywords normalizadas (sem stopwords, limitadas). */
export function keywordsOf(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}+\-/]+/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 4 && !STOPWORDS.has(word));
	return [...new Set(words)].slice(0, 12);
}

/** Confiança da análise (hints explícitos valem mais que heurística). */
function confidenceOf(
	rule: Rule,
	signals: readonly RuleSignal[],
): RuleAnalysis["confidence"] {
	const hints = rule.hints;
	const hintCount =
		(hints?.symbols?.length ?? 0) +
		(hints?.imports?.length ?? 0) +
		(hints?.decorators?.length ?? 0) +
		(hints?.paths?.length ?? 0) +
		(hints?.checks?.length ?? 0);
	if (hintCount > 0) return "high";
	if (signals.length > 0) return "medium";
	return "low";
}
