/**
 * Prompt do estado INVESTIGATE — o coração da coleta de evidências.
 */

import type { AgentContext } from "../../agent/agent-context";
import type { InvestigationTask } from "../../investigation/investigation-task";

/** Instruções do estado de investigação. */
export function investigatePrompt(
	context: AgentContext,
	tasks: readonly InvestigationTask[],
): string {
	const lines = [
		"## Tarefas priorizadas",
		...tasks.map(
			(task, index) =>
				`${index + 1}. [${task.severity}] ${task.rule} — arquivos: ${task.files.slice(0, 8).join(", ") || "(domínio)"}`,
		),
		"",
		"## Como investigar",
		"- Use file_outline/symbol_context/find_references em vez de ler arquivos inteiros.",
		"- Registre evidência para cada draft (evidenceIds).",
		"- Só proponha draft com `line` dentro do escopo do diff; código fora é contexto.",
		"- Prefira não concluir quando faltar evidência: use coverage 'skipped' com motivo.",
		"- Não cite arquivos fora do domínio/impacto.",
		"",
		"## Formato",
		"Produza JSON: { findingDrafts: [...], coverage: [{ rule, status, reason? }] }.",
	];
	if (context.files.length > 0) {
		lines.push(
			"",
			"## Arquivos do domínio",
			...context.files.slice(0, 40).map((file) => `- ${file}`),
		);
	}
	return lines.join("\n");
}
