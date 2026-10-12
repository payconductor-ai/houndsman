/**
 * Subcomando `watchdog` — contexto de um watchdog (biblioteca).
 *
 * Devolve o texto pronto (markdown ou JSON); `null` se o id não existe.
 * O CLI decide o log/exit.
 */

import type { HoundsmanConfig } from "../config";
import {
	type Rule,
	SEVERITY_EMOJI,
	severityRank,
	type WatchdogDefinition,
} from "../types";
import { findWatchdog, getWatchdogContext } from "../watchdog-registry";

export type WatchdogContextOptions = {
	/** Inclui `criticalRules` + `antiPatterns`. */
	withRules?: boolean;
	/** Saída JSON (default: markdown legível). */
	json?: boolean;
};

type WatchdogContext = ReturnType<typeof getWatchdogContext>;

/** Renderiza o contexto de um watchdog (markdown ou JSON). `null` se o id não existe. */
export function renderWatchdogContext(
	config: HoundsmanConfig,
	id: string,
	opts: WatchdogContextOptions = {},
): string | null {
	const def = findWatchdog(config, id);
	if (!def) return null;
	const ctx = getWatchdogContext(config, def.id);
	const withRules = opts.withRules ?? false;
	return opts.json
		? serializeWatchdogContext(ctx, def, withRules)
		: renderWatchdogMarkdown(ctx, def, withRules);
}

/** Payload serializável (regras incluídas apenas com `withRules`). */
function serializeWatchdogContext(
	ctx: WatchdogContext,
	def: WatchdogDefinition,
	withRules: boolean,
): string {
	const payload = withRules ? { ...ctx, rules: def.rules } : { ...ctx };
	return JSON.stringify(payload, null, 2);
}

/** Lista de itens em bloco `## <título>` (vazio se não houver itens). */
function section(title: string, items: readonly string[] | undefined): string[] {
	if (!items || items.length === 0) return [];
	return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
}

/** Regras com emoji de severidade em bloco `## <título>`. */
function ruleSection(title: string, rules: readonly Rule[]): string[] {
	return [
		`## ${title}`,
		"",
		...rules.map(
			(rule) =>
				`- ${SEVERITY_EMOJI[rule.severity]} **${rule.severity}** — ${rule.text}`,
		),
		"",
	];
}

/** Render markdown legível do contexto do watchdog. */
function renderWatchdogMarkdown(
	ctx: WatchdogContext,
	def: WatchdogDefinition,
	withRules: boolean,
): string {
	const lines: string[] = [
		`# ${ctx.name} (\`${ctx.id}\`)`,
		"",
		`**Descrição:** ${ctx.description}`,
		`**Escopo:** ${ctx.scope}`,
		"",
	];

	lines.push(...section("Prioridade de leitura", ctx.reviewFocus));
	lines.push(...section("Não carregar", ctx.exclude));
	lines.push(
		...section(
			"Docs de contexto",
			ctx.contextFiles.map((doc) => `\`${doc}\``),
		),
	);

	if (withRules) {
		lines.push(
			...ruleSection(
				"Regras",
				[...def.rules].sort(
					(a, b) => severityRank(a.severity) - severityRank(b.severity),
				),
			),
		);
	}

	return lines.join("\n").trimEnd();
}
