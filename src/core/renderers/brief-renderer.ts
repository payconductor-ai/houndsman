/**
 * Renderização de briefs (biblioteca) — superfície OO sobre `brief.ts`.
 *
 * O texto continua em `brief.ts` (funções puras); a classe existe para o
 * pipeline injetar o renderer sem depender da implementação.
 */

import { renderBrief } from "../brief";
import type { Watchdog } from "../domain/watchdog";
import type { WatchdogDefinition, WatchdogRenderArgs } from "../types";

/** Renderiza o brief de um watchdog (hook custom ou default). */
export class BriefRenderer {
	/** Render a partir de um `Watchdog` (domínio). */
	render(watchdog: Watchdog, args: WatchdogRenderArgs): string {
		return watchdog.renderBrief(args);
	}

	/** Render a partir da definição declarativa. */
	renderDefinition(definition: WatchdogDefinition, args: WatchdogRenderArgs): string {
		return renderBrief(definition, args);
	}
}
