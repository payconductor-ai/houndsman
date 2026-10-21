/**
 * Prompt do resumo de contexto da PR (`AiContextSummarizer`).
 */

import { buildSystem, clip, OUTPUT_LANGUAGE_RULE } from "./base";

/** Instruções de sistema do resumo. */
export function contextInstructions(): string {
	return buildSystem(
		"Você resume o contexto de uma Pull Request para revisores técnicos.",
		[
			OUTPUT_LANGUAGE_RULE,
			"Objetivo em até 2 frases (máx. 400 caracteres).",
			"Motivação em até 3 frases (máx. 480 caracteres), com o problema e o impacto esperado.",
			"Resumo das alterações em até 6 bullets (máx. 240 caracteres cada), focado em comportamento, fluxos e impacto.",
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
