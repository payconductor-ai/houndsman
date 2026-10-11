/**
 * Descoberta e carregamento da configuração do projeto — biblioteca.
 *
 * O motor é agnóstico: a config do projeto (`ReviewConfig`) é resolvida em
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
import type { ReviewConfig } from "./config";

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
	config: ReviewConfig<TId>;
	/** Caminho absoluto do arquivo de config carregado. */
	path: string;
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
 * Carrega o `ReviewConfig` do projeto. Lança se ausente ou inválido.
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

	const module = (await import(pathToFileURL(path).href)) as {
		default?: ReviewConfig<TId>;
		reviewConfig?: ReviewConfig<TId>;
	};
	const config = module.default ?? module.reviewConfig;

	if (!config) {
		throw new Error(
			`Configuração inválida em ${path}: exporte \`export default reviewConfig\`.`,
		);
	}
	if (!config.reviewers || typeof config.reviewers !== "object") {
		throw new Error(`Configuração inválida em ${path}: campo 'reviewers' ausente.`);
	}
	// Deriva `reviewerIds` de quem não passou por `defineReviewConfig` (ex.: objeto
	// literal) — mantém o motor robusto a configs escritas à mão.
	if (!Array.isArray(config.reviewerIds)) {
		(config as unknown as { reviewerIds: string[] }).reviewerIds = Object.keys(
			config.reviewers,
		);
	}

	return { config, path };
}
