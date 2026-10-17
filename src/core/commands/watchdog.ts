/**
 * Subcomando `watchdog` — contexto de um watchdog (biblioteca).
 *
 * Devolve o texto pronto (markdown ou JSON); `null` se o id não existe.
 * O CLI decide o log/exit.
 */

import type { HoundsmanConfig } from "../config";
import { WatchdogPresenter } from "../renderers/watchdog-presenter";
import { findWatchdog, getWatchdogContext } from "../watchdog-registry";

export type WatchdogContextOptions = {
	/** Inclui `criticalRules` + `antiPatterns`. */
	withRules?: boolean;
	/** Saída JSON (default: markdown legível). */
	json?: boolean;
};

const presenter = new WatchdogPresenter();

/** Renderiza o contexto de um watchdog (markdown ou JSON). `null` se o id não existe. */
export function renderWatchdogContext(
	config: HoundsmanConfig,
	id: string,
	opts: WatchdogContextOptions = {},
): string | null {
	const definition = findWatchdog(config, id);
	if (!definition) return null;
	return presenter.render(getWatchdogContext(config, definition.id), definition, {
		withRules: opts.withRules ?? false,
		json: opts.json ?? false,
	});
}
