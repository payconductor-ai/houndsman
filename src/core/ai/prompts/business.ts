/**
 * Prompt do modelo de intenção (`AiBusinessSummarizer`) e das hipóteses
 * (`AiBusinessAnalyzer`).
 *
 * Os dois derivam **do diff**, nunca da prosa da PR. O primeiro descreve o
 * contrato esperado; o segundo aponta suspeitas para o revisor `general`
 * confirmar ou refutar (nunca viram achado sozinhas).
 */

import { buildSystem, clip, OUTPUT_LANGUAGE_RULE } from "./base";

/** Instruções do resumo de negócio. */
export function businessInstructions(): string {
	return buildSystem(
		"Você reconstrói a intenção de uma Pull Request a partir do diff real.",
		[
			OUTPUT_LANGUAGE_RULE,
			"Descreva o comportamento que a PR promete entregar, não a estrutura do código.",
			"Derive do diff fornecido: fluxos, invariantes, contratos e estados.",
			"Paridade de capacidade é prioridade: se um lado declara feature/método/evento, verifique se o outro lado o honra.",
			"Fluxos de ciclo de vida contam: criação, renovação, cancelamento, retry, webhook e erro.",
			"Registre o que não estiver claro em `openQuestions`; não invente.",
			"NÃO produza achados, severidade, arquivo:linha ou recomendação de correção.",
			"Seja específico e curto: nomes de fluxo/contrato citam símbolos e arquivos reais.",
		],
	);
}

/** Prompt do usuário com o payload compactado. */
export function businessPrompt(payload: unknown): string {
	return [
		"Reconstrua a intenção da PR abaixo.",
		"",
		"```json",
		clip(JSON.stringify(payload), 24_000),
		"```",
		"",
		"Produza o modelo de intenção em JSON.",
	].join("\n");
}

/** Instruções das hipóteses de lógica/domínio. */
export function businessAnalysisInstructions(): string {
	return buildSystem(
		"Você aponta suspeitas de gap de lógica/domínio para um revisor confirmar.",
		[
			OUTPUT_LANGUAGE_RULE,
			"Use o modelo de intenção e os trechos alterados fornecidos.",
			"Cada hipótese precisa citar um arquivo do escopo e uma afirmação concreta.",
			"Prefira gaps de fluxo: caminho incompleto, capacidade declarada e não honrada, credencial/contexto divergente, estado sem tratamento, identificador trocado.",
			"Confiança calibrada (0–1); abaixo de 0.5 não vale reportar.",
			'`kind: "domain"` para invariantes/fluxo de negócio; `kind: "logic"` para nome/contrato vs comportamento.',
			"NÃO invente arquivos e NÃO produza severidade — isto não é um achado.",
			"No máximo 12 hipóteses.",
		],
	);
}

/** Prompt do usuário com intenção + trechos alterados. */
export function businessAnalysisPrompt(business: unknown, payload: unknown): string {
	return [
		"## Modelo de intenção",
		"",
		"```json",
		clip(JSON.stringify(business), 8_000),
		"```",
		"",
		"## Diff compactado",
		"",
		"```json",
		clip(JSON.stringify(payload), 16_000),
		"```",
		"",
		"Produza as hipóteses em JSON.",
	].join("\n");
}
