/**
 * Prompt do pré-passe de intenção no harness local (`houndsman hunt`).
 *
 * Executado antes dos watchdogs, com a IA embutida (maki). O output é o mesmo
 * `business-summary.json` que a skill grava via subagente.
 */

import { BUSINESS_SUMMARY_SCHEMA } from "../business-summary";

/** Dados do prompt de intenção. */
export type HuntIntentPromptInput = {
	projectName: string;
	/** Conteúdo de `business-brief.md` (já traz o modelo determinístico). */
	brief: string;
};

/** Monta o prompt do passo de intenção. */
export function renderHuntIntentPrompt(input: HuntIntentPromptInput): string {
	return [
		`Você é o passo de intenção da PR do projeto ${input.projectName}.`,
		"Leia o brief abaixo e devolva **apenas** o JSON do modelo de intenção.",
		"",
		"## Contrato do harness local",
		"",
		"- Use apenas leitura e busca; **não escreva arquivos** e não rode comandos.",
		"- Ignore a instrução do brief sobre gravar `outputPath`: o houndsman grava por você.",
		"- Responda **somente** com um objeto JSON válido (sem markdown, sem texto antes/depois).",
		'- Inclua `"source": "reviewer"`.',
		"- Não produza achados, severidade nem recomendações.",
		"",
		"### Schema",
		"",
		BUSINESS_SUMMARY_SCHEMA,
		"",
		"## Brief",
		"",
		input.brief.trim(),
	].join("\n");
}

/** Sufixo corretivo das retentativas do passo de intenção. */
export function renderIntentRetrySuffix(error: string): string {
	return [
		"",
		"## Correção obrigatória",
		"",
		`A resposta anterior foi rejeitada: ${error}`,
		"Responda APENAS com o objeto JSON do modelo de intenção, sem markdown.",
	].join("\n");
}
