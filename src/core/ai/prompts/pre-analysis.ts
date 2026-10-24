/**
 * Prompt da pré-análise por IA (`AiPreAnalyzer`).
 *
 * Candidatos não são achados: são indícios para o watchdog confirmar.
 */

import type { Rule } from "../../types";
import { buildSystem } from "./base";

/** Entrada do prompt. */
export type PreAnalysisPromptInput = {
	watchdogId: string;
	name: string;
	rules: readonly Rule[];
	files: readonly { file: string; snippet: string }[];
};

/** Instruções de sistema. */
export function preAnalysisInstructions(): string {
	return buildSystem(
		"Você faz uma pré-análise de possíveis violações de regras em um diff.",
		[
			"Produza candidatos apenas quando houver indício concreto no trecho alterado.",
			"O trecho fornecido é o diff (linhas alteradas); código não alterado é apenas contexto.",
			"Use o texto de uma das regras fornecidas.",
			"Confiança calibrada entre 0 e 1; prefira valores baixos na dúvida.",
			"Não invente arquivos.",
		],
	);
}

/** Prompt do usuário. */
export function preAnalysisPrompt(input: PreAnalysisPromptInput): string {
	return [
		`Watchdog: ${input.name} (${input.watchdogId})`,
		"",
		"## Regras",
		...input.rules.map((rule) => `- [${rule.severity}] ${rule.text}`),
		"",
		"## Arquivos e trechos alterados (diff)",
		...input.files.flatMap((item) => [
			`### ${item.file}`,
			"```",
			item.snippet,
			"```",
		]),
		"",
		"Produza os candidatos em JSON.",
	].join("\n");
}
