/**
 * Registry de watchdogs (biblioteca) — acesso tipado ao `HoundsmanConfig`.
 *
 * O motor não conhece ids concretos: o registry resolve definições, contexto e
 * casamento de arquivos por domínio. As funções antigas continuam como
 * adaptadores para a API pública.
 */

import { builtinWatchdog, GENERAL_WATCHDOG_ID, mergeGeneralWatchdog } from "./builtins";
import type { HoundsmanConfig } from "./config";
import { Watchdog, type WatchdogContext } from "./domain/watchdog";
import type { WatchdogDefinition } from "./types";

/** Coleção tipada de watchdogs do projeto. */
export class WatchdogRegistry<TId extends string = string> {
	private readonly config: HoundsmanConfig<TId>;

	constructor(config: HoundsmanConfig<TId>) {
		this.config = config;
	}

	/** Ids na ordem de declaração. */
	get ids(): readonly TId[] {
		return this.config.watchdogIds;
	}

	/** Definição de um watchdog (config vence; senão, built-in). */
	get(watchdogId: string): WatchdogDefinition {
		const definition = this.definitionOf(watchdogId);
		if (!definition) {
			throw new Error(`Watchdog '${watchdogId}' não encontrado.`);
		}
		return definition;
	}

	/** Busca null-safe por id. */
	find(watchdogId: string): Watchdog | null {
		const definition = this.definitionOf(watchdogId);
		return definition ? new Watchdog(definition) : null;
	}

	/**
	 * Resolve a definição: config primeiro, built-in depois. O `general` é
	 * reservado e sempre inclui o piso de lógica do motor (mesmo se o consumidor
	 * declarar um watchdog com esse id).
	 */
	private definitionOf(watchdogId: string): WatchdogDefinition | null {
		const configured = this.config.watchdogs[watchdogId as TId];
		if (watchdogId === GENERAL_WATCHDOG_ID) {
			return mergeGeneralWatchdog(configured);
		}
		return configured ?? builtinWatchdog(watchdogId);
	}

	/** Nome legível (default: o próprio id). */
	nameOf(watchdogId: string): string {
		return this.find(watchdogId)?.name ?? watchdogId;
	}

	/** Contexto essencial (sem regras). */
	context(watchdogId: string): WatchdogContext {
		return new Watchdog(this.get(watchdogId)).context();
	}

	/** Ids dos watchdogs que cobrem o arquivo. */
	matching(filePath: string, content?: string): TId[] {
		return this.config.watchdogIds.filter((id) =>
			new Watchdog(this.config.watchdogs[id]).matches(filePath, content),
		);
	}

	/** Todos os watchdogs (na ordem de declaração). */
	all(): Watchdog[] {
		return this.config.watchdogIds.map(
			(id) => new Watchdog(this.config.watchdogs[id]),
		);
	}
}

/** Acesso tipado a um watchdog do projeto (id string em runtime). */
export function getWatchdog<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
): WatchdogDefinition {
	return new WatchdogRegistry(config).get(watchdogId);
}

/** Busca null-safe por id string (runtime). */
export function findWatchdog<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
): WatchdogDefinition | null {
	return new WatchdogRegistry(config).find(watchdogId)?.definition ?? null;
}

/** Contexto "essencial" do watchdog — SEM regras (docs/UI/inspeção). */
export function getWatchdogContext<TId extends string>(
	config: HoundsmanConfig<TId>,
	watchdogId: string,
): WatchdogContext {
	return new WatchdogRegistry(config).context(watchdogId);
}
