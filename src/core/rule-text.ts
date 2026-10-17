/**
 * Texto de regra (biblioteca) — fonte única de polaridade e prefixos reservados.
 *
 * `RuleAnalyzer`, `registry-check` e o harness usam as mesmas listas: evita
 * divergência entre “Promover/Evitar” no analyzer e as validações anti-drift.
 * Também define o vocabulário de findings emergentes (lógica/domínio).
 */

/** Intenção de uma regra. */
export type RuleIntent = "promote" | "avoid";

/** Palavras que abrem uma regra de “deve acontecer”. */
export const PROMOTE_PREFIXES = [
	"promover",
	"deve",
	"dever",
	"use",
	"prefira",
	"sempre",
] as const;

/** Palavras que abrem uma regra de “não deve acontecer”. */
export const AVOID_PREFIXES = [
	"evitar",
	"não",
	"nao",
	"nunca",
	"proibido",
	"jamais",
] as const;

/** Conjunto normalizado (usado para remover polaridade das keywords). */
export const POLARITY_WORDS: ReadonlySet<string> = new Set([
	...PROMOTE_PREFIXES,
	...AVOID_PREFIXES,
]);

/** Escapa um literal para uso em regex. */
function escapeWord(word: string): string {
	return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex ancorada derivada das listas (sem repetir as palavras). */
function patternFor(words: readonly string[]): RegExp {
	return new RegExp(`^(${words.map(escapeWord).join("|")})\\b`);
}

const PROMOTE_PATTERN = patternFor(PROMOTE_PREFIXES);
const AVOID_PATTERN = patternFor(AVOID_PREFIXES);

/** Polaridade explícita; sem prefixo conhecido, assume `avoid`. */
export function polarityOf(text: string): RuleIntent {
	const normalized = text.trim().toLowerCase();
	if (PROMOTE_PATTERN.test(normalized)) return "promote";
	if (AVOID_PATTERN.test(normalized)) return "avoid";
	return "avoid";
}

/** `true` quando a regra declara polaridade explícita. */
export function hasExplicitPolarity(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return PROMOTE_PATTERN.test(normalized) || AVOID_PATTERN.test(normalized);
}

/** Prefixos reservados para findings emergentes (fora das regras explícitas). */
export const EMERGENT_PREFIXES = {
	logic: "Lógica:",
	domain: "Domínio:",
} as const;

/** Espécie de finding emergente. */
export type EmergentKind = keyof typeof EMERGENT_PREFIXES;

/** Espécie de um finding emergente (`null` quando não é emergente). */
export function emergentKind(rule: string): EmergentKind | null {
	const normalized = rule.trim();
	if (normalized.startsWith(EMERGENT_PREFIXES.logic)) return "logic";
	if (normalized.startsWith(EMERGENT_PREFIXES.domain)) return "domain";
	return null;
}

/** `true` quando a regra usa um prefixo emergente. */
export function isEmergentRule(rule: string): boolean {
	return emergentKind(rule) !== null;
}

/** Texto que sobra após o prefixo (vazio é inválido). */
export function emergentText(rule: string): string {
	const kind = emergentKind(rule);
	if (!kind) return "";
	return rule.trim().slice(EMERGENT_PREFIXES[kind].length).trim();
}

/** Monta o texto de um finding emergente. */
export function emergentRule(kind: EmergentKind, text: string): string {
	return `${EMERGENT_PREFIXES[kind]} ${text.trim()}`;
}
