/**
 * Validação do slug da run (`branch-slug`) usado nas URLs do servidor.
 *
 * Os dados vivem no storage global; a única preocupação restante aqui é barrar
 * slugs malformados antes de consultar o provider.
 */

/** Slugs aceitos: letras, números, ponto, underscore e hífen. */
const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** `true` se o slug é seguro/plausível. */
export function isSlug(value: string): boolean {
	return SLUG_PATTERN.test(value);
}
