/**
 * System prompt do revisor (harness nativo).
 *
 * Ordem estável: papel, regras, escopo, procedimento, contrato e segurança.
 * Descrições de tools vêm do `ToolRegistry` (nunca hardcoded).
 */

import { buildSystem } from "../../core/ai/prompts/base";
import { OUTPUT_FORMAT_PATH } from "../../core/paths";
import type { AgentContext } from "../agent/agent-context";

/** System prompt do agente. */
export function buildReviewerSystem(
	context: AgentContext,
	toolDescriptions: string,
): string {
	const rules = context.watchdog.rules.map(
		(rule) => `- [${rule.severity}] ${rule.text}`,
	);
	return buildSystem(
		`Você é um revisor sênior de ${context.projectName}, especialista no domínio '${context.watchdog.name}'.`,
		[
			"Você investiga o diff com tools read-only e só conclui com evidência.",
			"Nunca invente achado, arquivo, linha ou regra.",
			"Toda regra deve terminar com cobertura (checked, not_applicable ou skipped).",
			"blocking/attention exigem evidência rastreável.",
			context.watchdog.definition.allowEmergentFindings
				? "Findings emergentes de lógica/domínio usam `Lógica:`/`Domínio:`, exigem evidência e severidade máxima attention."
				: "Todo finding deve citar uma regra existente do watchdog.",
			"",
			"## Regras do watchdog",
			...rules,
			"",
			"## Escopo",
			context.watchdog.scope,
			"",
			"## Procedimento",
			"1. ORIENT — entenda regras, diff, AST e impacto.",
			"2. PLAN — escolha as tarefas priorizadas.",
			"3. INVESTIGATE — use tools para coletar evidências; refute hipóteses.",
			"4. VERIFY — cada draft precisa de evidência válida.",
			"5. CONCLUDE — produza o relatório.",
			"",
			"## Tools disponíveis",
			toolDescriptions,
			"",
			"## Contrato de saída",
			`O relatório final segue ${OUTPUT_FORMAT_PATH}.`,
			"Em INVESTIGATE produza JSON com findingDrafts e coverage.",
		],
	);
}

/** Prompt do usuário (contexto compactado; nunca arquivo inteiro). */
export function buildReviewerUser(context: AgentContext): string {
	const lines = [
		`Branch: ${context.branch}`,
		`Watchdog: ${context.watchdog.name} (${context.watchdog.id})`,
		`Arquivos do domínio (${context.files.length}):`,
		...context.files.slice(0, 40).map((file) => `- ${file}`),
	];
	if (context.overflow.length > 0) {
		lines.push(
			"",
			`Fora do orçamento (${context.overflow.length}) — NÃO ler; registrar em skipped:`,
			...context.overflow.slice(0, 40).map((file) => `- ${file}`),
		);
	}
	if (context.deleted.length > 0) {
		lines.push("", "Deletados:", ...context.deleted.map((file) => `- ${file}`));
	}
	if (context.context) {
		lines.push("", "## Contexto da PR");
		if (context.context.objective)
			lines.push(`Objetivo: ${context.context.objective}`);
		if (context.context.motivation)
			lines.push(`Motivação: ${context.context.motivation}`);
		for (const item of context.context.changeSummary ?? []) lines.push(`- ${item}`);
	}
	if (context.ast.size > 0) {
		lines.push("", "## Estrutura (AST)");
		for (const [file, analysis] of context.ast) {
			if (!analysis.delta) continue;
			const delta = analysis.delta;
			lines.push(
				`- ${file}: +${delta.addedSymbols.length} −${delta.removedSymbols.length} ~${delta.modifiedSymbols.length}`,
			);
		}
	}
	if (context.impact && context.impact.affectedFiles.length > 0) {
		lines.push(
			"",
			`Impacto: ${context.impact.affectedFiles.length} arquivo(s) importam o diff.`,
			...context.impact.affectedFiles.slice(0, 20).map((file) => `- ${file}`),
		);
	}
	if (context.docs.length > 0) {
		lines.push("", "Docs de contexto:", ...context.docs.map((doc) => `- ${doc}`));
	}
	return lines.join("\n");
}
