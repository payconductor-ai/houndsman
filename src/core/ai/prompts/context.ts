/**
 * Prompt do resumo de contexto da PR (`AiContextSummarizer`).
 */

import { buildSystem, clip } from "./base";

/** Instruções de sistema do resumo. */
export function contextInstructions(): string {
	return buildSystem(
		"Você resume o contexto de uma Pull Request para revisores técnicos.",
		[
			"Objetivo em uma frase (máx. 200 caracteres).",
			"Motivação em uma frase (máx. 240 caracteres).",
			"Resumo das alterações em até 4 bullets (máx. 160 caracteres cada).",
			"Não invente informação ausente do contexto.",
		],
	);
}

/** Prompt do usuário com o contexto bruto da PR. */
export function contextPrompt(raw: string): string {
	return [
		"Resuma o contexto da PR abaixo.",
		"",
		"```json",
		clip(raw, 12_000),
		"```",
	].join("\n");
}
