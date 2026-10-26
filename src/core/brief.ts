/**
 * Renderização do brief de um watchdog (biblioteca) — `defaultRenderBrief`.
 *
 * O procedimento (`PROCEDURE`) é compartilhado por todos os watchdogs; o que é
 * específico do domínio vive nas regras do watchdog (`rules`).
 */

import type { AstDelta } from "./ast/types";
import { GENERAL_WATCHDOG_ID } from "./builtins";
import { type BusinessSummary, renderBusinessLines } from "./business-summary";
import { formatRanges, formatSymbols } from "./changed-scope";
import {
	type Rule,
	SEVERITY_EMOJI,
	severityRank,
	type WatchdogDefinition,
	type WatchdogRenderArgs,
	type WatchdogRenderCandidate,
	type WatchdogRenderContext,
} from "./types";

/**
 * Procedimento de revisão — compartilhado por todos os watchdogs.
 *
 * O eixo é intenção → escopo → rastreio → prova: as regras continuam sendo o
 * piso, mas a revisão começa entendendo o que a mudança deve entregar.
 */
export const PROCEDURE: readonly string[] = [
	"1. **RECONSTRUCT** — leia o recorte do *Modelo de intenção (negócio)* e diga para si mesmo o que a mudança DEVE entregar (fluxos, invariantes, contratos). Sem modelo, derive do contexto da PR.",
	"2. **SCOPE** — os *Trechos alterados (diff)* já estão no brief: **não releia o arquivo inteiro** para vê-los. Trecho com o marcador `… [trecho truncado]` pode ser aberto, uma vez, para o restante.",
	"3. **TRACE** — siga cada símbolo alterado até seus chamadores, adapters e tipos compartilhados **dentro do seu domínio** (use os importadores do AST), **dentro do orçamento de exploração** (seção acima). Priorize os arquivos de maior churn.",
	"4. **GREP** — use as regras críticas/anti-padrões como heurística para localizar violações nas faixas alteradas, **dentro do orçamento**. Pare quando tiver a prova: repetir busca não aumenta certeza.",
	"5. **PROVE** — para cada suspeita, descreva gatilho → comportamento observado → invariante/regra violada. Sem prova, não é achado. Trecho com o marcador de truncamento só sustenta achado depois de abrir o arquivo para ver o restante.",
	'6. **CONCLUDE** — grave o JSON no caminho de output. `reviewedFiles` é um subconjunto de `## Arquivos do seu domínio` (só o que você revisou; **não** liste chamadores/importadores nem arquivos de outros domínios) e o que ficou de fora entra em `skipped` ("budget", "truncated" ou "fora do fluxo"). Máximo de 20 achados: priorize severidade e agrupe ocorrências idênticas. `line` dentro das faixas alteradas. Sem achados → `"findings": []` (arquivo obrigatório). Não escreva markdown livre.',
];

/**
 * Orçamento de exploração por brief.
 *
 * O diff já cobre o essencial; o resto é para chamador/contexto de um símbolo
 * citado. Sem teto, o subagente entrava em loop de leitura e cada brief levava
 * minutos — o `general` era o pior caso (PR inteira).
 */
const EXPLORATION_BUDGET = {
	general: { reads: 10, searches: 10 },
	domain: { reads: 6, searches: 6 },
} as const;

/** Seção com o teto de leituras/buscas do brief (visível para o modelo). */
function explorationSection(args: WatchdogRenderArgs): string[] {
	const budget =
		args.watchdogId === GENERAL_WATCHDOG_ID
			? EXPLORATION_BUDGET.general
			: EXPLORATION_BUDGET.domain;
	return [
		"## Orçamento de exploração",
		"",
		`> O diff já está no brief. Limite **neste brief**: ${budget.reads} leitura(s) de arquivo`,
		`> e ${budget.searches} busca(s) (grep).`,
		"> Abra arquivo só para chamador/contexto de um símbolo citado nos trechos.",
		"> Se a prova não estiver no brief nem nesse orçamento, **não é achado** —",
		"> registre a dúvida no campo `action` do finding mais próximo ou descarte.",
		"",
	];
}

/** Limites do contexto injetado em cada brief (o resumo final é maior). */
const BRIEF_CONTEXT_LIMITS = {
	objective: 200,
	motivation: 240,
	changeSummaryItem: 160,
	changeSummaryItems: 4,
} as const;

/** Bloco de contexto da PR, injetado no brief de cada watchdog. */
export function renderBriefContext(context: WatchdogRenderContext): string[] {
	const lines = ["## Contexto da PR", ""];
	if (context.objective) {
		lines.push(
			`**Objetivo:** ${shorten(context.objective, BRIEF_CONTEXT_LIMITS.objective)}`,
		);
	}
	if (context.motivation) {
		lines.push(
			`**Motivação:** ${shorten(context.motivation, BRIEF_CONTEXT_LIMITS.motivation)}`,
		);
	}
	const changeSummary = (context.changeSummary ?? []).slice(
		0,
		BRIEF_CONTEXT_LIMITS.changeSummaryItems,
	);
	if (changeSummary.length > 0) {
		lines.push("", "**Resumo das alterações:**", "");
		for (const item of changeSummary) {
			lines.push(`- ${shorten(item, BRIEF_CONTEXT_LIMITS.changeSummaryItem)}`);
		}
	}
	lines.push("");
	return lines;
}

/** Seção de candidatos pré-analisados (Jev) — o watchdog confirma ou refuta. */
export function renderBriefCandidates(
	candidates: readonly WatchdogRenderCandidate[],
): string[] {
	const lines = [
		"## Candidatos pré-analisados (Jev) — confirme ou refute",
		"",
		"> Indícios automáticos com confiança calibrada. **NÃO** são achados:",
		"> confirme (virando finding, com a `rule` abaixo) ou ignore se for falso positivo.",
		"",
	];
	for (const candidate of candidates) {
		lines.push(
			`- [ ] \`${candidate.file}\` · **${candidate.severity}** · confiança ${candidate.confidence.toFixed(2)}`,
			`  Regra: ${candidate.rule}`,
		);
	}
	lines.push("");
	return lines;
}

/**
 * Escopo do diff — as únicas faixas que podem virar finding.
 *
 * Sem ele, o watchdog tende a revisar o arquivo inteiro e reportar problemas
 * pré-existentes (fora do que a PR alterou).
 */
function changedScopeSection(args: WatchdogRenderArgs): string[] {
	const scope = args.changedScope;
	if (!scope) return [];
	const files = args.files.filter((file) => scope[file]);
	if (files.length === 0) return [];
	const lines: string[] = [
		"## Escopo do diff (símbolos alterados)",
		"",
		"> **Regra de escopo:** um finding só é válido quando a `line` está nas faixas",
		"> abaixo. Código fora delas é contexto — use para entender o impacto, nunca",
		"> como achado. Se a mudança quebra código não alterado, ancore o finding na",
		"> linha alterada que causou o problema.",
		"",
	];
	let rendered = 0;
	for (const file of files) {
		const entry = scope[file];
		if (!entry) continue;
		if (entry.ranges.length === 0) {
			lines.push(
				`- \`${file}\` — sem linhas alteradas (renomeado/binário): não reportar`,
			);
			rendered++;
			if (rendered >= 40) break;
			continue;
		}
		const fallback = entry.source === "hunks" ? " _(faixas do diff)_" : "";
		lines.push(`- \`${file}\` — linhas ${formatRanges(entry.ranges)}${fallback}`);
		const symbols = formatSymbols(entry.symbols);
		if (symbols) lines.push(`  símbolos: ${symbols}`);
		rendered++;
		if (rendered >= 40) break;
	}
	if (files.length > rendered) {
		lines.push(`- … +${files.length - rendered} arquivo(s)`);
	}
	lines.push("");
	return lines;
}

/** Linha de lista em code-span: `- \`valor\``. */
function codeItem(value: string): string {
	return `- \`${value}\``;
}

/** Linha de regra com número e emoji de severidade (o número é a identidade no checklist). */
function ruleItem(rule: Rule, index: number): string {
	return `- ${index}. ${SEVERITY_EMOJI[rule.severity]} **${rule.severity}** — ${rule.text}`;
}

/**
 * Contrato de severidade do output — a severidade é derivada, não escolhida.
 *
 * Finding de regra carrega a severidade declarada em `Rule.severity`; emergente
 * carrega `impactClass`, mapeado em `core/severity.ts`. Isso impede o mesmo
 * código de sair `blocking` numa review e `attention` na seguinte.
 */
export const SEVERITY_GUIDE: readonly string[] = [
	"- **Finding de regra:** copie `rule` exatamente como no brief. A severidade é a **declarada na regra** — outro valor é ignorado e corrigido pelo motor.",
	"- **Finding emergente** (`Lógica:`/`Domínio:`): preencha `impactClass` — `flow-break` (fluxo/capacidade não honrada), `contract-drift` (contrato/estado divergente), `degradation` (borda/erro frágil) ou `cosmetic`.",
	"- `blocking` fora de regra continua exigindo `scenario` + `evidence`; sem os dois, o motor rebaixa para `attention`.",
];

/** Seção opcional (`## <título>` + itens) — vazia se não houver itens. */
function optionalList(title: string, items: readonly string[] | undefined): string[] {
	if (!items || items.length === 0) return [];
	return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
}

/** Lista de arquivos do domínio com status (e churn, quando disponível). */
function fileItems(args: WatchdogRenderArgs): string[] {
	return args.files.map((file) => {
		const status = args.statuses[file]?.status ?? "modified";
		const churn = args.churn?.[file];
		const delta = churn ? `, +${churn.additions}/−${churn.deletions}` : "";
		return `- \`${file}\` (${status}${delta})`;
	});
}

/**
 * Arquivos do domínio fora do recorte (orçamento ou fluxo): o watchdog NÃO
 * deve lê-los, mas precisa registrá-los em `skipped` — cobertura honesta.
 */
function overflowSection(args: WatchdogRenderArgs): string[] {
	const overflow = args.overflow ?? [];
	if (overflow.length === 0) return [];
	return [
		"## Fora do recorte (NÃO revisar)",
		"",
		`> ${overflow.length} arquivo(s) do escopo ficaram fora do recorte`,
		"> (orçamento ou prioridade de fluxo). Não os leia: registre-os em `skipped`",
		"> com o motivo (`budget` ou `fora do fluxo`) para que a cobertura fique honesta.",
		"",
		...overflow.map(codeItem),
		"",
	];
}

/** Seção de deletados (breaking change) — só p/ watchdogs com `breakingChange`. */
function deletedSection(args: WatchdogRenderArgs, def: WatchdogDefinition): string[] {
	if (!def.breakingChange || args.deleted.length === 0) return [];
	return [
		"## Deletados — checar breaking change",
		"",
		...args.deleted.map(codeItem),
		"",
	];
}

/** Escapa um valor para uso em code-span (evita quebrar o markdown). */
function inlineCode(value: string): string {
	return `\`${value.replace(/`/g, "'")}\``;
}

/** Trunca um texto longo (assinatura) para o brief. */
function shorten(value: string, max = 120): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Linhas de um delta estrutural (compactas e determinísticas). */
function deltaLines(delta: AstDelta): string[] {
	const lines: string[] = [];
	for (const symbol of delta.addedSymbols.slice(0, 4)) {
		lines.push(`+ ${inlineCode(symbol.name)} (${symbol.kind})`);
	}
	for (const symbol of delta.removedSymbols.slice(0, 4)) {
		lines.push(`− ${inlineCode(symbol.name)} (${symbol.kind})`);
	}
	for (const symbol of delta.modifiedSymbols.slice(0, 4)) {
		lines.push(`~ ${inlineCode(symbol.name)} (${symbol.kind})`);
	}
	for (const change of delta.changedSignatures.slice(0, 3)) {
		lines.push(
			`assinatura ${inlineCode(change.name)}: ${inlineCode(shorten(change.before) || "—")} → ${inlineCode(shorten(change.after) || "—")}`,
		);
	}
	if (delta.addedImports.length > 0) {
		lines.push(
			`imports + ${delta.addedImports.slice(0, 4).map(inlineCode).join(", ")}`,
		);
	}
	if (delta.removedImports.length > 0) {
		lines.push(
			`imports − ${delta.removedImports.slice(0, 4).map(inlineCode).join(", ")}`,
		);
	}
	return lines;
}

/** Rótulo curto da fonte do modelo de intenção. */
const BUSINESS_SOURCE_LABEL: Record<BusinessSummary["source"], string> = {
	ai: "IA",
	reviewer: "revisor de fluxo",
	deterministic: "determinístico",
};

/**
 * Recorte do modelo de intenção: só fluxos que tocam os arquivos do watchdog.
 *
 * O modelo é global; injetá-lo inteiro em cada brief fazia o subagente
 * perseguir fluxos de outros domínios (mais leituras e buscas sem achado).
 */
function scopeBusinessToFiles(
	business: BusinessSummary,
	files: readonly string[],
): BusinessSummary {
	if (files.length === 0) return business;
	// O modelo vem da IA e pode usar `./`, `\` ou caminho absoluto: normaliza
	// antes de comparar para não perder um fluxo do próprio domínio.
	const normalize = (value: string): string =>
		value.replace(/\\/g, "/").replace(/^\.\//, "");
	const own = new Set(files.map(normalize));
	const flows = business.flows.filter(
		(flow) =>
			!flow.files ||
			flow.files.length === 0 ||
			flow.files.some((file) => own.has(normalize(file))),
	);
	if (flows.length === business.flows.length) return business;
	return { ...business, flows };
}

/**
 * Modelo de intenção da PR — o contrato esperado antes de julgar o código.
 *
 * Injetado em todos os briefs; o revisor `general` recebe o modelo completo, os
 * watchdogs de domínio recebem só o recorte dos seus arquivos.
 */
function businessSection(args: WatchdogRenderArgs): string[] {
	const business = args.business;
	if (!business) return [];
	const isGeneral = args.watchdogId === GENERAL_WATCHDOG_ID;
	const scoped = isGeneral
		? business
		: { ...scopeBusinessToFiles(business, args.files), openQuestions: [] };
	const omitted = business.flows.length - scoped.flows.length;
	// O caminho canônico só interessa a quem reconstrói o modelo (`general`):
	// nos demais, citá-lo induzia uma leitura extra do JSON completo.
	const canonical =
		args.businessSummaryPath && (isGeneral || args.flowReview)
			? ` · \`${args.businessSummaryPath}\` (versão canônica no staging)`
			: "";
	const lines = [
		"## Modelo de intenção (negócio)",
		"",
		`> Fonte: ${BUSINESS_SOURCE_LABEL[business.source]}${canonical}. Use para saber o que a mudança **deve** entregar; não é achado.`,
		"",
	];
	if (!isGeneral) {
		lines.push(
			"> Recorte do seu domínio: fluxos/arquivos de outros domínios pertencem a outros watchdogs — não os investigue.",
			...(omitted > 0
				? [`> ${omitted} fluxo(s) fora do seu domínio foram omitidos.`]
				: []),
			"",
		);
	}
	const rendered = renderBusinessLines(
		scoped,
		isGeneral
			? { flows: 12, invariants: 12, contracts: 12, states: 8 }
			: { flows: 3, invariants: 6, contracts: 2, states: 2 },
	);
	while (rendered[0] === "") rendered.shift();
	lines.push(...rendered, "");
	return lines;
}

/** Trechos alterados (diff) — todos os watchdogs recebem o patch do seu domínio. */
function snippetsSection(args: WatchdogRenderArgs): string[] {
	const snippets = args.snippets ?? [];
	if (snippets.length === 0) return [];
	const lines = [
		"## Trechos alterados (diff)",
		"",
		"> Trechos já extraídos do diff (`-U0`, só linhas alteradas). Eles bastam",
		"> para achar violações: **não abra os arquivos apenas para reler o que já",
		"> está aqui**. Use o arquivo só para contexto adjacente ou chamadores.",
		"",
	];
	for (const item of snippets) {
		lines.push(
			`### \`${item.file}\``,
			"",
			"```diff",
			item.snippet.trimEnd(),
			"```",
			"",
		);
	}
	return lines;
}

/**
 * Obrigação de output do revisor de fluxo: ele reconstrói e persiste o modelo
 * de intenção (ou devolve `businessSummary` no harness local).
 */
function flowReviewSection(args: WatchdogRenderArgs): string[] {
	if (!args.flowReview) return [];
	const output = args.businessSummaryPath ?? "business-summary.json";
	return [
		"## Obrigação de output (fluxo)",
		"",
		"1. **Recomece pelo modelo**: leia o diff e reconstrua intenção, fluxos, invariantes,",
		"   contratos e estados. Se o modelo existente estiver incompleto, corrija-o.",
		`2. **Persista** o modelo em \`${output}\` com \`source: "reviewer"\`.`,
		"   No harness local (maki), devolva o mesmo objeto em `businessSummary` no JSON.",
		"3. **Prove cada gap**: fora de regra, preencha `scenario` (gatilho concreto),",
		"   `impact` (consequência observável) e `evidence` (trecho). Sem `scenario` + `evidence`,",
		"   a severidade máxima é `attention`.",
		"",
	];
}

/** Linha de verificação (string legada ou objeto ancorado). */
function checkItem(
	item:
		| string
		| { statement: string; file?: string; symbol?: string; invariant?: string },
): string {
	if (typeof item === "string") return `- ${item}`;
	const anchor = [item.file, item.symbol].filter(Boolean).join(" · ");
	const invariant = item.invariant ? ` (invariante: ${item.invariant})` : "";
	return `- ${item.statement}${anchor ? ` — \`${anchor}\`` : ""}${invariant}`;
}

/**
 * Plano de revisão sugerido por IA — complementa (nunca substitui) as regras.
 */
function aiPlanSection(args: WatchdogRenderArgs): string[] {
	const plan = args.aiPlan;
	if (!plan) return [];
	const focus = plan.focus ?? [];
	const questions = plan.questions ?? [];
	const risks = plan.risks ?? [];
	const logic = plan.logic ?? [];
	const domain = plan.domain ?? [];
	if (
		focus.length === 0 &&
		questions.length === 0 &&
		risks.length === 0 &&
		logic.length === 0 &&
		domain.length === 0
	) {
		return [];
	}
	const lines = [
		"## Plano de revisão (IA) — sugestão",
		"",
		"> Sugestão automática para orientar a leitura. **Não** substitui as regras",
		"> do watchdog nem dispensa confirmar cada violação no código.",
		"",
	];
	if (focus.length > 0) {
		lines.push("**Foco de leitura:**", "");
		for (const item of focus.slice(0, 5)) lines.push(`- ${item}`);
		lines.push("");
	}
	if (questions.length > 0) {
		lines.push("**Perguntas de verificação:**", "");
		for (const item of questions.slice(0, 3)) lines.push(`- ${item}`);
		lines.push("");
	}
	if (risks.length > 0) {
		lines.push("**Riscos prováveis:**", "");
		for (const item of risks.slice(0, 3)) lines.push(`- ${item}`);
		lines.push("");
	}
	if (logic.length > 0) {
		lines.push("**Consistência lógica:**", "");
		for (const item of logic.slice(0, 4)) lines.push(checkItem(item));
		lines.push("");
	}
	if (domain.length > 0) {
		lines.push("**Domínio de negócio:**", "");
		for (const item of domain.slice(0, 4)) lines.push(checkItem(item));
		lines.push("");
	}
	return lines;
}

/**
 * Micro-alterações iguais em muitos arquivos: mostra o padrão dominante e os
 * outliers em vez de N diffs de uma linha.
 */
function propagationSection(args: WatchdogRenderArgs): string[] {
	const cluster = args.propagation;
	if (!cluster || cluster.files.length === 0) return [];
	const sample = cluster.files.slice(0, 5).map(inlineCode).join(", ");
	const rest = cluster.files.length > 5 ? ` (+${cluster.files.length - 5})` : "";
	const lines = [
		"## Propagação mecânica",
		"",
		`> ${cluster.files.length} arquivo(s) com a mesma micro-alteração (≤3 linhas).`,
		"> Revise o padrão e os outliers; **não abra** os demais — registre-os em",
		"> `skipped` com o motivo `propagação mecânica`.",
		"",
		"```diff",
		...cluster.lines.map((line) => `+${line}`),
		"```",
		"",
		`Arquivos: ${sample}${rest}`,
		"",
	];
	if (cluster.outliers.length > 0) {
		lines.push("**Outliers (revisar):**", "");
		for (const outlier of cluster.outliers) {
			lines.push(
				`- ${inlineCode(outlier.file)}: \`${shorten(outlier.lines.join(" ⏎ "), 160)}\``,
			);
		}
		lines.push("");
	}
	return lines;
}

/** Contratos alterados cujos importadores não aparecem no diff. */
function propagationGapSection(args: WatchdogRenderArgs): string[] {
	const gaps = args.propagationGaps ?? [];
	if (gaps.length === 0) return [];
	const lines = [
		"## Possível propagação incompleta",
		"",
		"> Contratos alterados cujos importadores **não** aparecem no diff. Confirme",
		"> se cada um precisa acompanhar a mudança antes de concluir.",
		"",
	];
	for (const gap of gaps) {
		lines.push(
			`- ${inlineCode(gap.file)} → ${gap.importers.map(inlineCode).join(", ")}`,
		);
	}
	lines.push("");
	return lines;
}

/**
 * Estrutura/delta dos arquivos do watchdog (AST). É um mapa para orientar a
 * leitura — o watchdog confirma no código e não trata como achado.
 */
function astSection(args: WatchdogRenderArgs): string[] {
	const entries = args.ast ?? [];
	if (entries.length === 0) return [];
	const lines: string[] = [
		"## Estrutura (AST)",
		"",
		"> Delta estrutural dos arquivos do seu domínio. Use como mapa para",
		"> priorizar a leitura; **não** é achado por si só.",
		"",
	];
	let rendered = 0;
	for (const entry of entries) {
		const parts = deltaLines(entry.delta);
		if (entry.importers && entry.importers.length > 0) {
			parts.push(
				`impacto: ${entry.importers.slice(0, 5).map(inlineCode).join(", ")}` +
					(entry.importers.length > 5
						? ` (+${entry.importers.length - 5})`
						: ""),
			);
		}
		if (parts.length === 0) continue;
		lines.push(
			`### ${inlineCode(entry.file)}`,
			"",
			...parts.map((part) => `- ${part}`),
			"",
		);
		rendered++;
		if (rendered >= 12) break;
	}
	if (rendered === 0) return [];
	return lines;
}

/**
 * Render padrão do brief de um watchdog (ordem estável).
 * `def` é a definição do próprio watchdog (evita ciclo com o registry).
 */
export function defaultRenderBrief(
	args: WatchdogRenderArgs,
	def: WatchdogDefinition,
): string[] {
	const lines: string[] = [
		`# Brief — ${def.name} (\`${def.id}\`)`,
		"",
		`**Branch:** ${args.branch}`,
		...(args.worktree ? [`**Worktree:** \`${args.worktree}\``] : []),
		`**Output obrigatório:** \`${args.outputPath}\``,
		`**Schema do output:** \`${args.outputFormatPath}\``,
		"",
	];

	if (def.description) lines.push("## Objetivo", "", def.description, "");
	lines.push("## Escopo do domínio", "", def.scope, "");

	lines.push(...changedScopeSection(args));

	if (args.context) lines.push(...renderBriefContext(args.context));

	lines.push(...businessSection(args));
	lines.push(...snippetsSection(args));
	lines.push(...propagationSection(args));
	lines.push(...propagationGapSection(args));
	lines.push(...flowReviewSection(args));
	lines.push(...aiPlanSection(args));
	lines.push(...astSection(args));
	lines.push(...optionalList("Prioridade de leitura", def.reviewFocus));
	lines.push(
		"## Regras (por severidade)",
		"",
		...[...def.rules]
			.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
			.map((rule, index) => ruleItem(rule, index + 1)),
		"",
	);
	lines.push("## Como declarar a severidade", "", ...SEVERITY_GUIDE, "");
	lines.push(
		"## Docs de contexto (carregar sob demanda)",
		"",
		...args.docs.map(codeItem),
		"",
	);
	lines.push(
		`## Arquivos do seu domínio (${args.files.length})`,
		"",
		...fileItems(args),
		"",
	);

	lines.push(...overflowSection(args));

	if (args.candidates && args.candidates.length > 0) {
		lines.push(...renderBriefCandidates(args.candidates));
	}

	lines.push(...deletedSection(args, def));
	lines.push(...optionalList("Não carregar", def.exclude));
	lines.push(...explorationSection(args));
	lines.push("## Procedimento", "", ...PROCEDURE);

	return lines;
}

/**
 * Renderiza o brief via hook custom (`def.renderBrief`) ou o padrão.
 * Passa a própria definição para que o hook possa reutilizar o render padrão.
 */
export function renderBrief(def: WatchdogDefinition, args: WatchdogRenderArgs): string {
	const render = def.renderBrief ?? defaultRenderBrief;
	return render(args, def).join("\n");
}
