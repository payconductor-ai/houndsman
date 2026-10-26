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
  "checks": [
    {
      "item": "fluxo ou invariante copiado do brief",
      "verdict": "ok | gap | n/a",
      "at": "arquivo:linha ou arquivo · símbolo"
    }
  ],
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
      "impactClass": "flow-break | contract-drift | degradation | cosmetic",
      "confidence": 0.8,
      "basis": "rule | logic | domain"
    }
  ]
}`;
}

/** Protocolo de revisão do harness (independe do domínio do watchdog). */
const PROTOCOL: readonly string[] = [
	"1. **INTENÇÃO** — liste os fluxos e invariantes do *Modelo de intenção* do brief. Para cada um, localize o trecho que o implementa (ou a ausência dele).",
	"2. **ESCOPO** — só é achado a `line` dentro das faixas do *Escopo do diff*. Abra primeiro os arquivos com `… [trecho truncado]`: o restante não está no brief.",
	"3. **RASTREIO** — para cada símbolo alterado, siga chamadores, adapters, enums e tipos compartilhados (seção *Estrutura (AST)*/importadores) e confira os dois lados do contrato.",
	"4. **PROVA** — gatilho → comportamento observado → invariante/regra violada. Sem prova no brief ou no orçamento de exploração, descarte.",
	"5. **AUTOVERIFICAÇÃO** — antes de responder, reconfira cada finding: linha no escopo, `evidence` como trecho literal, `severity` compatível com o `impact`.",
	"6. **COBERTURA** — `reviewedFiles` ∪ `skipped` cobre todo *Arquivos do seu domínio*; não declare arquivo que você não abriu.",
];

/** Calibração que o harness precisa declarar (o agente da skill já a segue). */
const CALIBRATION: readonly string[] = [
	"Cada fluxo ou invariante do brief deve aparecer em `checks` com o texto copiado do brief e um veredito: `ok` (implementado), `gap` (ausente/divergente) ou `n/a` (não se aplica ao domínio).",
	"`gap` sem finding correspondente é inconsistência: ou inclua o finding, ou corrija o veredito.",
	"Calibre pelo impacto comprovado: dinheiro/credencial roteada para outra conta, cobrança perdida ou corrupção de estado, com `scenario` + `evidence` e linha no escopo, é `blocking`. Não rebaixe para `attention` só por incerteza — nesse caso reduza `confidence`.",
	"Não pare no primeiro achado de um arquivo: fluxos de pagamento têm vários lados (criação, renovação, cancelamento, webhook, erro).",
];

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
		"- Finding de regra: copie `rule` do brief — a severidade é a declarada na regra. Emergente: declare `impactClass`; a severidade vem daí.",
		...(input.watchdogId === GENERAL_WATCHDOG_ID
			? [
					'- Este é o revisor de fluxo: inclua `businessSummary` (modelo de intenção reconstruído, `source: "reviewer"`) no JSON.',
				]
			: []),
		"",
		"## Protocolo de revisão",
		"",
		...PROTOCOL,
		"",
		"## Calibração",
		"",
		...CALIBRATION.map((line) => `- ${line}`),
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

/**
 * Sufixo da passada de checklist: só os itens do modelo de intenção que a
 * primeira resposta não verificou.
 */
export function renderChecklistSuffix(missing: readonly string[]): string {
	return [
		"",
		"## Verificação obrigatória (checklist)",
		"",
		"A resposta anterior não verificou os itens abaixo. Para **cada um**: localize",
		"o trecho no código (ou a ausência), registre em `checks` (`ok`/`gap`/`n/a`,",
		"texto copiado do brief) e, quando `gap`, inclua o finding correspondente.",
		"",
		...missing.map((item) => `- ${item}`),
		"",
		"Devolva o relatório **completo**: todos os findings já encontrados + os novos,",
		"`checks` com todos os itens do brief e `reviewedFiles`/`skipped` atualizados.",
	].join("\n");
}
