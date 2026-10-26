/**
 * Prompt do watchdog no harness local.
 *
 * O brief original manda gravar o JSON em `findings/<id>.json`. No maki o
 * watchdog **não** recebe permissão de escrita: ele devolve o JSON na resposta
 * final e o houndsman valida e grava. Este módulo só acrescenta o contrato;
 * não altera o brief usado pela skill `/houndsman hunt`.
 */

/** Dados do prompt de um watchdog. */
export type HuntPromptInput = {
	projectName: string;
	watchdogId: string;
	/** Conteúdo do brief renderizado pelo prepare. */
	brief: string;
	/**
	 * `false` no revisor de fluxo (`general`): a passada base só caça achados e
	 * não gasta atenção preenchendo `checks`/`rules` — o bookkeeping roda numa
	 * passada própria (mais barata) depois.
	 */
	bookkeeping?: boolean;
	/** Pede o modelo de intenção no JSON (só quando não há modelo da IA). */
	requestBusiness?: boolean;
};

/** Schema compacto repetido no prompt (evita depender de arquivo externo). */
function outputSchema(
	watchdogId: string,
	options: { bookkeeping: boolean; business: boolean },
): string {
	const bookkeeping = options.bookkeeping
		? `,
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
  ]`
		: "";
	const business = options.business
		? `,
  "businessSummary": {
    "flows": [{ "name": "fluxo", "files": ["caminho"] }],
    "invariants": ["invariante"],
    "contracts": ["contrato"],
    "states": ["estado"],
    "source": "reviewer"
  }`
		: "";
	return `{
  "watchdogId": "${watchdogId}",
  "reviewedFiles": ["caminho/relativo.ts"],
  "skipped": ["arquivo não lido + motivo"]${bookkeeping},
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
  ]${business}
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

/** Calibração do bookkeeping (checks/rules) — só quando o prompt o pede. */
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

/**
 * Calibração do revisor de fluxo quando ele **não** faz bookkeeping.
 *
 * Concentra o que o modelo headless mais erra: parar no caminho feliz, tratar
 * cada arquivo isoladamente e aceitar divergência entre caminhos parecidos.
 */
const FLOW_CALIBRATION: readonly string[] = [
	"Seu produto é **achado**, não checklist: `checks`/`rules` são preenchidos em uma passada posterior. Não gaste a resposta listando vereditos.",
	"Para cada fluxo do *Modelo de intenção*: onde começa, onde termina, quem chama, que estado muda e quem lê esse estado depois. A ausência do trecho é achado tanto quanto o trecho errado.",
	"Percorra os **caminhos irmãos** do fluxo e compare-os entre si: criação × renovação × cancelamento × webhook × retry/erro. Divergência de payload, credencial, split, id ou status entre irmãos é o achado mais comum e o mais caro.",
	"Siga o **contrato até o consumidor**: mapa de status, enum, `Record<Enum, X>`, schema de model, tipo compartilhado. Um membro novo de enum sem consumidor atualizado quebra em tempo de compilação ou em runtime.",
	"Procure **estado compartilhado**: campo de instância/módulo que guarda credencial, contexto ou id entre requisições, fallback silencioso para a credencial mestre e reset tardio.",
	"`rule` nunca fica vazio: finding de regra copia o texto da regra do brief (sem o número); emergente usa `Lógica: <descrição>` ou `Domínio: <descrição>` (com `impactClass`).",
	"Calibre pelo impacto comprovado: dinheiro/credencial roteada para outra conta, cobrança perdida ou corrupção de estado, com `scenario` + `evidence` e linha no escopo, é `blocking`. Não rebaixe para `attention` só por incerteza — nesse caso reduza `confidence`.",
	"Não pare no primeiro achado de um arquivo: fluxos de pagamento têm vários lados (criação, renovação, cancelamento, webhook, erro).",
];

/** Monta o prompt enviado ao maki para um brief. */
export function renderHuntPrompt(input: HuntPromptInput): string {
	const bookkeeping = input.bookkeeping !== false;
	const business = input.requestBusiness === true;
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
		...(business
			? [
					'- Inclua `businessSummary` (modelo de intenção reconstruído, `source: "reviewer"`) no JSON.',
				]
			: []),
		"",
		"## Protocolo de revisão",
		"",
		...PROTOCOL,
		"",
		"## Calibração",
		"",
		...(bookkeeping ? CALIBRATION : FLOW_CALIBRATION).map((line) => `- ${line}`),
		"",
		"### Schema",
		"",
		outputSchema(input.watchdogId, { bookkeeping, business }),
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
		outputSchema(watchdogId, { bookkeeping: true, business: false }),
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
 * Cinco classes que o modelo headless mais deixa passar.
 *
 * A ordem é a da taxa de acerto observada: credencial/estado compartilhado
 * (o caso clássico de `sellerApiKey` de instância) é o que mais escapava.
 */
export const ADVERSARIAL_CLASSES: readonly string[] = [
	"1. **Credencial e contexto compartilhado** — estado mutável de instância/módulo usado entre requisições (apiKey, token, seller, subconta), fallback silencioso para a credencial mestre, reset tardio.",
	"2. **Capacidade anunciada** — feature/método/evento declarado que algum lado não honra (feature herdada, paridade criação/renovação/cancelamento, webhook).",
	"3. **Identificador persistido** — o id gravado corresponde à entidade que o contrato espera (authorizationId × paymentId, externalId, endToEnd, externalReference).",
	"4. **Idempotência e transição de estado** — evento repetido/atrasado, transição sem validar o estado atual, efeito colateral duplicado.",
	"5. **Contrato entre lados** — mapper/schema/model divergindo do consumidor (validação, status, campos, unidade).",
];

/** Achado já encontrado, resumido para a passada adversarial. */
export type AdversarialCandidate = {
	rule: string;
	severity: string;
	file: string;
	line?: number;
	message: string;
};

/** Dados da segunda opinião em sessão nova. */
export type AdversarialPromptInput = {
	projectName: string;
	watchdogId: string;
	brief: string;
	/** Achados da primeira passada: contexto para não duplicar, não para ancorar. */
	candidates: readonly AdversarialCandidate[];
};

/**
 * Segunda opinião em **sessão nova**.
 *
 * Reexecutar a passada na mesma sessão, depois do checklist, ancora o modelo nas
 * próprias conclusões (na prática devolvia zero achados novos). Aqui o revisor
 * vê o brief de novo, recebe os achados apenas como lista de "já cobertos" e é
 * cobrado a atacar as cinco classes com prova.
 */
export function renderAdversarialPrompt(input: AdversarialPromptInput): string {
	const covered =
		input.candidates.length === 0
			? ["Nenhum achado na primeira passada — o brief está **inteiro** em aberto."]
			: [
					"Já cobertos (NÃO repita; use como pista do que o revisor anterior olhou):",
					"",
					...input.candidates.map((candidate) => {
						const line =
							candidate.line !== undefined ? `:${candidate.line}` : "";
						return `- ${candidate.severity} · \`${candidate.file}${line}\` — ${candidate.rule} — ${candidate.message.slice(0, 200)}`;
					}),
				];
	return [
		`Você é o revisor adversarial do fluxo do projeto ${input.projectName} (watchdog \`${input.watchdogId}\`).`,
		"Esta é uma **sessão nova**: ninguém aqui revisou estes arquivos ainda. O objetivo é achar o que a primeira passada não achou.",
		"",
		"## Contrato do harness local",
		"",
		"- Use apenas leitura e busca; **não escreva arquivos** e não rode comandos.",
		"- Responda **somente** com um objeto JSON válido (sem markdown, sem texto antes/depois).",
		`- \`watchdogId\` deve ser exatamente \`${input.watchdogId}\`.`,
		"- `line` deve estar dentro do escopo do diff descrito no brief.",
		"- Devolva **apenas os achados novos**; não repita os já cobertos.",
		"",
		...covered,
		"",
		"## Classes a atacar",
		"",
		"Percorra **cada classe** abaixo e, para cada uma, traga o achado com",
		"`arquivo:linha` e prova — ou conclua que não há ocorrência no escopo.",
		"",
		...ADVERSARIAL_CLASSES,
		"",
		"Regras da passada:",
		"- Sem `scenario` + `evidence` o achado não passa de `attention`.",
		"- Não repita os achados já cobertos acima e não invente para preencher classe.",
		"- Achado de regra copia o texto da regra do brief; fora de regra use",
		"  `Lógica:`/`Domínio:` com `impactClass`.",
		"",
		"### Schema",
		"",
		outputSchema(input.watchdogId, { bookkeeping: false, business: false }),
		"",
		"## Brief",
		"",
		input.brief.trim(),
	].join("\n");
}

/** Dados da passada de bookkeeping (só vereditos). */
export type BookkeepingPromptInput = {
	projectName: string;
	watchdogId: string;
	brief: string;
	/** Itens do modelo de intenção ainda sem veredito. */
	items: readonly string[];
	/** Regras numeradas do brief ainda sem veredito. */
	ruleIds: readonly number[];
};

/**
 * Passada de bookkeeping do revisor de fluxo (sessão nova e barata).
 *
 * Antes, o `general` tinha que devolver achados **e** o checklist no mesmo JSON
 * de 61 KB — na prática ele entregava 2 achados e 10/10 checks "ok" sem lastro.
 * Separar os papéis deixa a passada forte focada em achar e esta em provar.
 */
export function renderBookkeepingPrompt(input: BookkeepingPromptInput): string {
	return [
		`Você é o verificador de checklist do projeto ${input.projectName} (watchdog \`${input.watchdogId}\`).`,
		"Sua única tarefa é **verificar** os itens abaixo no código e devolver os vereditos.",
		"",
		"## Contrato",
		"",
		"- Use apenas leitura e busca; não escreva arquivos e não rode comandos.",
		"- Responda **somente** com um objeto JSON válido (sem markdown).",
		"- `findings` deve ser sempre `[]`: esta passada não caça achados.",
		"- Para cada item, `at` é obrigatório quando o veredito é `ok` (`arquivo:linha` real do código); use `n/a` quando o item não se aplica ao domínio.",
		"- `gap` exige `at` apontando onde o item deveria estar (ou o símbolo ausente).",
		"",
		"## Itens de intenção a verificar",
		"",
		...input.items.map((item) => `- ${item}`),
		"",
		"## Regras numeradas a verificar",
		"",
		...(input.ruleIds.length > 0 ? [input.ruleIds.join(", ")] : ["(nenhuma)"]),
		"",
		"### Schema",
		"",
		outputSchema(input.watchdogId, { bookkeeping: true, business: false }),
		"",
		"## Brief",
		"",
		input.brief.trim(),
	].join("\n");
}
