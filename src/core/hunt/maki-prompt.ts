/**
 * Prompt do watchdog no harness local.
 *
 * O brief original manda gravar o JSON em `findings/<id>.json`. No maki o
 * watchdog **não** recebe permissão de escrita: ele devolve o JSON na resposta
 * final e o houndsman valida e grava. Este módulo só acrescenta o contrato;
 * não altera o brief usado pela skill `/houndsman hunt`.
 */

import { GENERAL_WATCHDOG_ID } from "../builtins";

/** Dados do prompt de um watchdog. */
export type HuntPromptInput = {
	projectName: string;
	watchdogId: string;
	/** Conteúdo do brief renderizado pelo prepare. */
	brief: string;
};

/** Schema compacto repetido no prompt (evita depender de arquivo externo). */
function outputSchema(watchdogId: string): string {
	return `{
  "watchdogId": "${watchdogId}",
  "reviewedFiles": ["caminho/relativo.ts"],
  "skipped": ["arquivo não lido + motivo"],
  "findings": [
    {
      "rule": "regra do brief",
      "severity": "blocking | attention | suggestion | nit",
      "file": "caminho/relativo.ts",
      "line": 123,
      "message": "o que está errado",
      "action": "o que fazer",
      "evidence": "trecho que comprova",
      "scenario": "gatilho concreto que expõe o gap (fora de regra)",
      "impact": "consequência observável",
      "confidence": 0.8,
      "basis": "rule | logic | domain"
    }
  ]
}`;
}

/** Monta o prompt enviado ao maki para um brief. */
export function renderHuntPrompt(input: HuntPromptInput): string {
	return [
		`Você é o watchdog \`${input.watchdogId}\` do projeto ${input.projectName}.`,
		"Execute o brief abaixo e devolva os achados como JSON.",
		"",
		"## Contrato do harness local",
		"",
		"- Use apenas leitura e busca; **não escreva arquivos** e não rode comandos.",
		"- Ignore a instrução do brief sobre gravar `outputPath`: o houndsman grava por você.",
		"- Responda **somente** com um objeto JSON válido (sem markdown, sem texto antes/depois).",
		"- `watchdogId` deve ser exatamente o id acima; use `findings: []` quando não houver achado.",
		"- `line` deve estar dentro do escopo do diff descrito no brief.",
		'- Fora de regra, use `basis: "logic" | "domain"`, com `scenario` + `evidence`; sem os dois a severidade máxima é `attention`.',
		...(input.watchdogId === GENERAL_WATCHDOG_ID
			? [
					'- Este é o revisor de fluxo: inclua `businessSummary` (modelo de intenção reconstruído, `source: "reviewer"`) no JSON.',
				]
			: []),
		"",
		"### Schema",
		"",
		outputSchema(input.watchdogId),
		"",
		"## Brief",
		"",
		input.brief.trim(),
	].join("\n");
}

/** Sufixo corretivo das retentativas (saída inválida). */
export function renderRetrySuffix(error: string): string {
	return [
		"",
		"## Correção obrigatória",
		"",
		`A resposta anterior foi rejeitada: ${error}`,
		"Responda APENAS com o objeto JSON completo, no schema acima, sem markdown.",
	].join("\n");
}
