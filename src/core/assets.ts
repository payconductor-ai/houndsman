/**
 * Resolução dos assets embarcados no pacote (`src/skill/`) — biblioteca.
 *
 * Usados para **gerar** a camada de projeto (`houndsman setup`/`update`), não
 * para resolver caminhos em runtime. Derivados da localização do módulo — não
 * do cwd.
 */

import { join } from "node:path";

/** Diretório de assets markdown embarcados no pacote. */
export const SKILL_DIR = join(import.meta.dir, "..", "skill");

/** Diretório de assets de mídia do pacote (root `assets/` — logo etc.). */
export const MEDIA_DIR = join(import.meta.dir, "..", "..", "assets");

/** Diretório das grammars tree-sitter embarcadas (wasm). */
export const GRAMMAR_DIR = join(MEDIA_DIR, "grammars");

/** Runtime e grammars copiados para a camada do projeto pelo setup/update. */
export const GRAMMAR_FILES = [
	"web-tree-sitter.wasm",
	"tree-sitter-typescript.wasm",
	"tree-sitter-tsx.wasm",
	"tree-sitter-javascript.wasm",
] as const;

/** Nome do arquivo de schema de output dos watchdogs. */
export const OUTPUT_FORMAT_FILE = "OUTPUT-FORMAT.md";

/** Nome do arquivo-base do skill (`SKILL.md`) — entry point escrito para cada harness. */
export const SKILL_FILE = "SKILL.md";

/** Caminho absoluto de um asset embarcado em `src/skill/`. */
export function assetPath(fileName: string): string {
	return join(SKILL_DIR, fileName);
}

/** Caminho absoluto de um asset de mídia em `assets/` (ex.: a logo). */
export function mediaPath(fileName: string): string {
	return join(MEDIA_DIR, fileName);
}

/** Caminho absoluto de uma grammar wasm em `assets/grammars/`. */
export function grammarPath(fileName: string): string {
	return join(GRAMMAR_DIR, fileName);
}
