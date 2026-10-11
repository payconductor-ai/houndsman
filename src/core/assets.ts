/**
 * Resolução de assets embarcados no pacote (`src/skill/`) — biblioteca.
 *
 * Usados quando o projeto não define um caminho próprio (ex.: o schema de
 * output dos revisores). Derivados da localização do módulo — não do cwd.
 */

import { join } from "node:path";

/** Diretório de assets markdown embarcados no pacote. */
export const SKILL_DIR = join(import.meta.dir, "..", "skill");

/** Nome do arquivo de schema de output dos revisores. */
export const OUTPUT_FORMAT_FILE = "OUTPUT-FORMAT.md";

/** Caminho absoluto de um asset embarcado em `src/skill/`. */
export function assetPath(fileName: string): string {
	return join(SKILL_DIR, fileName);
}

/** Caminho do schema de output default do pacote. */
export function defaultOutputFormatPath(): string {
	return assetPath(OUTPUT_FORMAT_FILE);
}
