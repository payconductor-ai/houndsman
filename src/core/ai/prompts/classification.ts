/**
 * Prompt da classificação fallback (`AiClassifier`).
 */

import { buildSystem } from "./base";

/** Entrada do prompt de classificação. */
export type ClassificationPromptInput = {
	files: readonly string[];
	watchdogs: readonly { id: string; name: string; scope: string }[];
};

/** Instruções de sistema. */
export function classificationInstructions(): string {
	return buildSystem(
		"Você classifica arquivos alterados nos domínios (watchdogs) de uma revisão.",
		[
			"Atribua cada arquivo ao watchdog cujo escopo melhor corresponde.",
			"Se nenhum watchdog servir, omita o arquivo.",
			"Use apenas ids de watchdog fornecidos.",
		],
	);
}

/** Prompt do usuário. */
export function classificationPrompt(input: ClassificationPromptInput): string {
	return [
		"## Watchdogs",
		...input.watchdogs.map((w) => `- ${w.id}: ${w.name} — ${w.scope}`),
		"",
		"## Arquivos",
		...input.files.slice(0, 100).map((file) => `- ${file}`),
		"",
		"Produza as atribuições em JSON.",
	].join("\n");
}
