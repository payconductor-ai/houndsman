/**
 * Renderização do brief de um revisor (biblioteca) — `defaultRenderBrief`.
 *
 * O procedimento (`PROCEDURE`) é compartilhado por todos os revisores; o que era
 * protocolo específico vive nas regras do revisor (`rules`).
 */

import {
	type ReviewerDefinition,
	type ReviewerRenderArgs,
	type ReviewerRenderCandidate,
	type ReviewerRenderContext,
	type Rule,
	SEVERITY_EMOJI,
	severityRank,
} from "./types";

/**
 * Procedimento de revisão — compartilhado por todos os revisores.
 * Substitui o antigo protocolo genérico de 5 passos + o ponteiro `PROTOCOL_GLOB`.
 */
export const PROCEDURE: readonly string[] = [
	"1. **FILTER** — descarte o que não for do seu domínio (ver *Prioridade de leitura* e *Não carregar*).",
	"2. **READ HEAD** — leia os arquivos seletivamente (primeiras ~30 linhas). NUNCA o diff completo.",
	"3. **GREP** — use as regras críticas/anti-padrões como heurística para localizar violações.",
	"4. **DEEP-READ** — aprofunde apenas os arquivos com suspeita de violação.",
	'5. **CONCLUDE** — grave o JSON no caminho de output, com `reviewedFiles` preenchido. Sem achados → `"findings": []` (arquivo obrigatório). Não escreva markdown livre.',
];

/** Bloco de contexto da PR, injetado no brief de cada revisor. */
export function renderBriefContext(context: ReviewerRenderContext): string[] {
	const lines = ["## Contexto da PR", ""];
	if (context.objective) lines.push(`**Objetivo:** ${context.objective}`);
	if (context.motivation) lines.push(`**Motivação:** ${context.motivation}`);
	const changeSummary = context.changeSummary ?? [];
	if (changeSummary.length > 0) {
		lines.push("", "**Resumo das alterações:**", "");
		for (const item of changeSummary) lines.push(`- ${item}`);
	}
	lines.push("");
	return lines;
}

/** Seção de candidatos pré-analisados (Jev) — o revisor confirma ou refuta. */
export function renderBriefCandidates(
	candidates: readonly ReviewerRenderCandidate[],
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

/** Linha de lista em code-span: `- \`valor\``. */
function codeItem(value: string): string {
	return `- \`${value}\``;
}

/** Linha de regra com emoji de severidade. */
function ruleItem(rule: Rule): string {
	return `- ${SEVERITY_EMOJI[rule.severity]} **${rule.severity}** — ${rule.text}`;
}

/** Seção opcional (`## <título>` + itens) — vazia se não houver itens. */
function optionalList(title: string, items: readonly string[] | undefined): string[] {
	if (!items || items.length === 0) return [];
	return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
}

/** Lista de arquivos do domínio com status. */
function fileItems(args: ReviewerRenderArgs): string[] {
	return args.files.map((file) => {
		const status = args.statuses[file]?.status ?? "modified";
		return `- \`${file}\` (${status})`;
	});
}

/** Seção de deletados (breaking change) — só p/ revisores com `breakingChange`. */
function deletedSection(args: ReviewerRenderArgs, def: ReviewerDefinition): string[] {
	if (!def.breakingChange || args.deleted.length === 0) return [];
	return [
		"## Deletados — checar breaking change",
		"",
		...args.deleted.map(codeItem),
		"",
	];
}

/**
 * Render padrão do brief de um revisor (ordem estável).
 * `def` é a definição do próprio revisor (evita ciclo com o registry).
 */
export function defaultRenderBrief(
	args: ReviewerRenderArgs,
	def: ReviewerDefinition,
): string[] {
	const lines: string[] = [
		`# Brief — ${def.name} (\`${def.id}\`)`,
		"",
		`**Branch:** ${args.branch}`,
		`**Output obrigatório:** \`${args.outputPath}\``,
		`**Schema do output:** \`${args.outputFormatPath}\``,
		"",
	];

	if (def.description) lines.push("## Objetivo", "", def.description, "");
	lines.push("## Escopo", "", def.scope, "");

	if (args.context) lines.push(...renderBriefContext(args.context));

	lines.push(...optionalList("Prioridade de leitura", def.reviewFocus));
	lines.push(
		"## Regras (por severidade)",
		"",
		...[...def.rules]
			.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
			.map(ruleItem),
		"",
	);
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

	if (args.candidates && args.candidates.length > 0) {
		lines.push(...renderBriefCandidates(args.candidates));
	}

	lines.push(...deletedSection(args, def));
	lines.push(...optionalList("Não carregar", def.exclude));
	lines.push("## Procedimento", "", ...PROCEDURE);

	return lines;
}

/**
 * Renderiza o brief via hook custom (`def.renderBrief`) ou o padrão.
 * Passa a própria definição para que o hook possa reutilizar o render padrão.
 */
export function renderBrief(def: ReviewerDefinition, args: ReviewerRenderArgs): string {
	const render = def.renderBrief ?? defaultRenderBrief;
	return render(args, def).join("\n");
}
