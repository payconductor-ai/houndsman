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
  "rules": [
    {
      "id": 1,
      "verdict": "ok | gap | n/a",
      "at": "arquivo:linha"
    }
  ],
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
	"`rules` cobre **cada regra numerada** de `## Regras (por severidade)` — um item `{ id, verdict }` por número, sem repetir o texto. `gap` numa regra exige o finding correspondente.",
	"`ok` exige `at` com `arquivo:linha` real (onde o item é implementado); sem localização comprovada, use `n/a`.",
	"`gap` sem finding correspondente é inconsistência: ou inclua o finding, ou corrija o veredito.",
	"O checklist cobre a **intenção**; ele não substitui as regras do brief — percorra cada regra nas linhas do escopo e reporte a violação.",
	"`rule` nunca fica vazio: finding de regra copia o texto da regra do brief (sem o número); emergente usa `Lógica: <descrição>` ou `Domínio: <descrição>` (com `impactClass`).",
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
 * Correção em sessão retomada: o agente já leu o brief e explorou o código.
 *
 * Repetir o brief inteiro num processo novo custava uma nova exploração
 * completa (~30 turnos) só porque a resposta final não era JSON parseável.
 * Aqui só pedimos a saída, com o schema compacto.
 */
export function renderResumeSuffix(error: string, watchdogId: string): string {
	return [
		"",
		"## Correção obrigatória (sessão retomada)",
		"",
		`A resposta anterior não pôde ser lida: ${error}`,
		"Não leia mais arquivos nem rode buscas. Responda apenas com o objeto JSON",
		"completo no schema abaixo — sem markdown, sem texto antes ou depois.",
		"",
		outputSchema(watchdogId),
	].join("\n");
}

/**
 * Sufixo da passada de checklist: regras e itens do modelo de intenção que a
 * primeira resposta não verificou.
 */
export function renderChecklistSuffix(
	missing: readonly string[],
	missingRules: readonly number[] = [],
): string {
	return [
		"",
		"## Verificação obrigatória (checklist)",
		"",
		"A resposta anterior não verificou os itens abaixo. Para **cada um**: localize",
		"o trecho no código (ou a ausência), registre o veredito (`ok`/`gap`/`n/a`) e,",
		"quando `gap`, inclua o finding correspondente.",
		"",
		...(missingRules.length > 0
			? [
					`Regras não verificadas (ids de \`## Regras\`): ${missingRules.join(", ")}.`,
					"",
				]
			: []),
		...(missing.length > 0
			? [
					"Fluxos/invariantes (texto copiado do brief):",
					"",
					...missing.map((item) => `- ${item}`),
					"",
				]
			: []),
		"Devolva o relatório **completo**: todos os findings já encontrados + os novos,",
		"`rules`/`checks` completos e `reviewedFiles`/`skipped` atualizados.",
	].join("\n");
}

/**
 * Passada adversarial do revisor de fluxo.
 *
 * Roda depois do checklist e ataca as cinco classes que o modelo headless mais
 * deixa passar — em especial credencial/estado compartilhado entre requisições
 * (o caso clássico de `sellerApiKey` de instância).
 */
export function renderSecondOpinionSuffix(): string {
	return [
		"",
		"## Segunda opinião (revisão adversarial)",
		"",
		"Você já revisou o brief. Faça **uma** passada adversarial focada apenas nas",
		"cinco classes abaixo, citando `arquivo:linha` e prova para cada achado **novo**:",
		"",
		"1. **Credencial e contexto compartilhado** — estado mutável de instância/módulo usado entre requisições (apiKey, token, seller, subconta), fallback silencioso para a credencial mestre, reset tardio.",
		"2. **Capacidade anunciada** — feature/método/evento declarado que algum lado não honra (feature herdada, paridade criação/renovação/cancelamento, webhook).",
		"3. **Identificador persistido** — o id gravado corresponde à entidade que o contrato espera (authorizationId × paymentId, externalId, endToEnd, externalReference).",
		"4. **Idempotência e transição de estado** — evento repetido/atrasado, transição sem validar o estado atual, efeito colateral duplicado.",
		"5. **Contrato entre lados** — mapper/schema/model divergindo do consumidor (validação, status, campos, unidade).",
		"",
		"Regras da passada:",
		"- Só reporte o que **ainda não está** em `findings` — não repita achados anteriores.",
		"- `line` continua obrigatória dentro do *Escopo do diff* do brief.",
		"- Devolva o relatório completo no mesmo schema: findings anteriores + novos,",
		"  `rules` e `checks` completos.",
		"- Sem achado novo, devolva o relatório anterior sem inventar.",
	].join("\n");
}
