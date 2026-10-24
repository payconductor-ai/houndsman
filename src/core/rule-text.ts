/**
 * Texto de regra (biblioteca) — fonte única dos prefixos de polaridade.
 *
 * `registry-check` usa a mesma lista para validar que a regra declara
 * “Promover/Evitar” explicitamente.
 */

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

/** `true` quando a regra declara polaridade explícita. */
export function hasExplicitPolarity(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return PROMOTE_PATTERN.test(normalized) || AVOID_PATTERN.test(normalized);
}
