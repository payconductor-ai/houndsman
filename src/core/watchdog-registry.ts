/**
 * Acesso tipado aos watchdogs de um `HoundsmanConfig` (biblioteca).
 *
 * O motor não conhece ids concretos — tudo chega via `config`.
 */

import type { HoundsmanConfig } from "./config";
import type { WatchdogDefinition } from "./types";

/** Acesso tipado a um watchdog do projeto (id string em runtime). */
export function getWatchdog<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
): WatchdogDefinition {
	return config.watchdogs[watchdogId as TId];
}

/** Busca null-safe por id string (runtime). */
export function findWatchdog<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
): WatchdogDefinition | null {
	return config.watchdogs[watchdogId as TId] ?? null;
}

/** Contexto "essencial" do watchdog — SEM regras (docs/UI/inspeção). */
export function getWatchdogContext<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
) {
	const { id, name, description, scope, reviewFocus, exclude, contextFiles } =
		getWatchdog(config, watchdogId);
	return {
		id,
		name,
		description,
		scope,
		reviewFocus,
		exclude,
		contextFiles,
	};
}
