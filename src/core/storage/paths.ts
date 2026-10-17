/**
 * Localização global do houndsman (biblioteca).
 *
 * O banco e o staging vivem no diretório de dados do usuário — nunca dentro do
 * projeto nem da instalação npm. `HOUNDSMAN_HOME` sobrescreve tudo (útil em
 * testes e para manter múltiplos ambientes).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HoundsmanConfig } from "../config";

export const HOUNDSMAN_HOME_ENV = "HOUNDSMAN_HOME";

/** Diretório-base global do houndsman. */
export function houndsmanHome(): string {
	const override = process.env[HOUNDSMAN_HOME_ENV];
	if (override && override.trim().length > 0) return resolve(override);

	const home = homedir();
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		return join(
			local && local.length > 0 ? local : join(home, "AppData", "Local"),
			"houndsman",
		);
	}
	if (process.platform === "darwin") {
		return join(home, "Library", "Application Support", "houndsman");
	}
	const xdg = process.env.XDG_DATA_HOME;
	return join(xdg && xdg.length > 0 ? xdg : join(home, ".local", "share"), "houndsman");
}

/** Caminho do banco SQLite (config `storage.path` ou `<home>/houndsman.db`). */
export function databasePath(config: HoundsmanConfig): string {
	const configured = config.storage?.path;
	if (configured && configured.trim().length > 0) return resolve(configured);
	return join(houndsmanHome(), "houndsman.db");
}

/** Raiz das runs do provider de arquivos (config `storage.path` ou `<home>/runs`). */
export function fileRoot(config: HoundsmanConfig): string {
	const configured = config.storage?.path;
	if (configured && configured.trim().length > 0) return resolve(configured);
	return join(houndsmanHome(), "runs");
}

/** Raiz do staging por review (briefs/findings/contexto dos subagentes). */
export function workRoot(): string {
	return join(houndsmanHome(), "work");
}

/** Referência legível do storage configurado (diagnóstico). */
export function storageLocation(config: HoundsmanConfig): string {
	return config.storage?.provider === "file"
		? `file:${fileRoot(config)}`
		: `sqlite:${databasePath(config)}`;
}

/** Diretório de staging de uma review. */
export function workDir(reviewId: string): string {
	return join(workRoot(), reviewId);
}
