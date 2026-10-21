/**
 * Descoberta e carregamento da configuração do projeto — biblioteca.
 *
 * O motor é agnóstico: a config do projeto (`HoundsmanConfig`) é resolvida em
 * runtime a partir do cwd do consumidor — nunca importada estaticamente.
 *
 * Ordem de resolução:
 *   1. `--config <path>` (explícito)
 *   2. `houndsman.config.{ts,mts,js,mjs}`
 *   3. `.houndsman/config.{ts,js}`
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HoundsmanConfig } from "./config";

/** Nomes de arquivo procurados no cwd, em ordem de precedência. */
export const CONFIG_FILE_CANDIDATES: readonly string[] = [
	"houndsman.config.ts",
	"houndsman.config.mts",
	"houndsman.config.js",
	"houndsman.config.mjs",
	".houndsman/config.ts",
	".houndsman/config.js",
];

export type LoadedConfig<TId extends string = string> = {
	config: HoundsmanConfig<TId>;
	/** Caminho absoluto do arquivo de config carregado. */
	path: string;
};

/** Forma do módulo de config (default ou export nomeado). */
type ConfigModule<TId extends string> = {
	default?: HoundsmanConfig<TId>;
	houndsmanConfig?: HoundsmanConfig<TId>;
};

/** Primeiro arquivo de config existente no diretório (ou `null`). */
export function resolveConfigPath(cwd: string = process.cwd()): string | null {
	for (const name of CONFIG_FILE_CANDIDATES) {
		const candidate = join(cwd, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const MISSING_CONFIG_HINT =
	"Nenhuma configuração do houndsman encontrada.\n" +
	`Esperado: ${CONFIG_FILE_CANDIDATES.join(" | ")} na raiz do projeto.\n` +
	"Rode `houndsman setup` para criar uma configuração inicial.";

/**
 * Carrega o `HoundsmanConfig` do projeto. Lança se ausente ou inválido.
 * `configPath` sobrepõe a descoberta automática.
 */
export async function loadConfig<TId extends string = string>(
	options: { cwd?: string; configPath?: string } = {},
): Promise<LoadedConfig<TId>> {
	const cwd = options.cwd ?? process.cwd();
	const path = options.configPath
		? resolve(cwd, options.configPath)
		: resolveConfigPath(cwd);

	if (!path || !existsSync(path)) {
		throw new Error(MISSING_CONFIG_HINT);
	}

	let module: ConfigModule<TId>;
	try {
		module = (await import(pathToFileURL(path).href)) as ConfigModule<TId>;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// Causa comum: camada gerada ausente (`.houndsman/core`), importada pelos
		// watchdogs como `../core/types` — típico de worktree ainda não sincronizado.
		throw new Error(
			`Falha ao carregar ${path}: ${detail}\n` +
				"A camada gerada (`.houndsman/core`) existe? Rode `houndsman update` na raiz do projeto.",
		);
	}
	const config = module.default ?? module.houndsmanConfig;

	if (!config) {
		throw new Error(
			`Configuração inválida em ${path}: exporte \`export default houndsmanConfig\`.`,
		);
	}
	if (!config.watchdogs || typeof config.watchdogs !== "object") {
		throw new Error(`Configuração inválida em ${path}: campo 'watchdogs' ausente.`);
	}
	// Deriva `watchdogIds` de quem não passou por `defineHoundsmanConfig` (ex.: objeto
	// literal) — mantém o motor robusto a configs escritas à mão.
	if (!Array.isArray(config.watchdogIds)) {
		(config as unknown as { watchdogIds: string[] }).watchdogIds = Object.keys(
			config.watchdogs,
		);
	}

	return { config, path };
}
