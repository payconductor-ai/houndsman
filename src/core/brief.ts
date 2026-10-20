/**
 * Renderização do brief de um watchdog (biblioteca) — `defaultRenderBrief`.
 *
 * O procedimento (`PROCEDURE`) é compartilhado por todos os watchdogs; o que é
 * específico do domínio vive nas regras do watchdog (`rules`).
 */

import type { AstDelta } from "./ast/types";
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
 */
export const PROCEDURE: readonly string[] = [
	"1. **FILTER** — descarte o que não for do seu domínio (ver *Prioridade de leitura* e *Não carregar*).",
	"2. **READ HEAD** — leia os arquivos seletivamente (primeiras ~30 linhas). NUNCA o diff completo.",
	"3. **GREP** — use as regras críticas/anti-padrões como heurística para localizar violações.",
	"4. **DEEP-READ** — aprofunde apenas os arquivos com suspeita de violação.",
	'5. **CONCLUDE** — grave o JSON no caminho de output, com `reviewedFiles` preenchido. Sem achados → `"findings": []` (arquivo obrigatório). Não escreva markdown livre.',
];

/** Bloco de contexto da PR, injetado no brief de cada watchdog. */
export function renderBriefContext(context: WatchdogRenderContext): string[] {
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
 * Arquivos do domínio fora do orçamento (triage de PRs grandes): o watchdog NÃO
 * deve lê-los, mas precisa registrá-los em `skipped` — cobertura honesta.
 */
function overflowSection(args: WatchdogRenderArgs): string[] {
	const overflow = args.overflow ?? [];
	if (overflow.length === 0) return [];
	return [
		"## Fora do orçamento (NÃO revisar)",
		"",
		`> ${overflow.length} arquivo(s) do seu domínio ficaram fora do orçamento`,
		"> (menor churn). Não os leia: registre-os em `skipped` com o motivo",
		'> "budget" para que a cobertura do relatório fique honesta.',
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
		for (const item of logic.slice(0, 3)) lines.push(`- ${item}`);
		lines.push("");
	}
	if (domain.length > 0) {
		lines.push("**Domínio de negócio:**", "");
		for (const item of domain.slice(0, 3)) lines.push(`- ${item}`);
		lines.push("");
	}
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
	lines.push("## Escopo", "", def.scope, "");

	if (args.context) lines.push(...renderBriefContext(args.context));

	lines.push(...aiPlanSection(args));
	lines.push(...astSection(args));
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

	lines.push(...overflowSection(args));

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
export function renderBrief(def: WatchdogDefinition, args: WatchdogRenderArgs): string {
	const render = def.renderBrief ?? defaultRenderBrief;
	return render(args, def).join("\n");
}
