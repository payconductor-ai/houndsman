/**
 * Apresentação do contexto de um watchdog (biblioteca) — markdown/JSON.
 */

import type { WatchdogContext } from "../domain/watchdog";
import {
	type Rule,
	SEVERITY_EMOJI,
	severityRank,
	type WatchdogDefinition,
} from "../types";

/** Opções de apresentação do watchdog. */
export type WatchdogRenderOptions = {
	/** Inclui as regras. */
	withRules: boolean;
	/** Saída JSON (default: markdown). */
	json: boolean;
};

/** Renderiza o contexto de um watchdog. */
export class WatchdogPresenter {
	render(
		context: WatchdogContext,
		definition: WatchdogDefinition,
		options: WatchdogRenderOptions,
	): string {
		return options.json
			? this.serialize(context, definition, options.withRules)
			: this.markdown(context, definition, options.withRules);
	}

	/** Payload serializável (regras incluídas apenas com `withRules`). */
	private serialize(
		context: WatchdogContext,
		definition: WatchdogDefinition,
		withRules: boolean,
	): string {
		const payload = withRules
			? { ...context, rules: definition.rules }
			: { ...context };
		return JSON.stringify(payload, null, 2);
	}

	/** Lista de itens em bloco `## <título>` (vazio se não houver itens). */
	private section(title: string, items: readonly string[] | undefined): string[] {
		if (!items || items.length === 0) return [];
		return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
	}

	/** Regras com emoji de severidade em bloco `## <título>`. */
	private ruleSection(title: string, rules: readonly Rule[]): string[] {
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
	private markdown(
		context: WatchdogContext,
		definition: WatchdogDefinition,
		withRules: boolean,
	): string {
		const lines: string[] = [
			`# ${context.name} (\`${context.id}\`)`,
			"",
			`**Descrição:** ${context.description}`,
			`**Escopo:** ${context.scope}`,
			"",
		];

		lines.push(...this.section("Prioridade de leitura", context.reviewFocus));
		lines.push(...this.section("Não carregar", context.exclude));
		lines.push(
			...this.section(
				"Docs de contexto",
				context.contextFiles.map((doc) => `\`${doc}\``),
			),
		);

		if (withRules) {
			lines.push(
				...this.ruleSection(
					"Regras",
					[...definition.rules].sort(
						(a, b) => severityRank(a.severity) - severityRank(b.severity),
					),
				),
			);
		}

		return lines.join("\n").trimEnd();
	}
}
