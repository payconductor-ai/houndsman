/**
 * Prompt do enriquecimento de brief (`AiBriefEnricher`).
 *
 * A saída é apenas um **plano sugerido** (foco, perguntas e riscos). Ela não
 * pode criar regras nem achados.
 */

import type { AstFileBrief } from "../../ast/types";
import { type BusinessSummary, renderBusinessLines } from "../../business-summary";
import type { ChangedScope } from "../../changed-scope";
import type { ChurnMap, Rule, WatchdogRenderContext } from "../../types";
import { buildSystem } from "./base";

/** Entrada do prompt do brief. */
export type BriefPromptInput = {
	watchdogId: string;
	name: string;
	description: string;
	scope: string;
	rules: readonly Rule[];
	files: readonly string[];
	churn?: ChurnMap;
	context?: WatchdogRenderContext | null;
	ast?: readonly AstFileBrief[];
	docs?: readonly string[];
	/** Modelo de intenção da PR (contrato esperado). */
	business?: BusinessSummary | null;
	/** Trechos alterados — a única fonte real para verificar lógica. */
	snippets?: readonly { file: string; snippet: string }[];
	/** Faixas revisáveis por arquivo. */
	changedScope?: ChangedScope;
};

/** Instruções de sistema do enriquecimento. */
export function briefInstructions(): string {
	return buildSystem(
		"Você é um revisor sênior que prepara um plano de leitura para um watchdog (revisor) especializado.",
		[
			"As regras fornecidas são o PISO da revisão, não o teto.",
			"Derive cada verificação dos trechos alterados fornecidos — não apenas do nome do arquivo.",
			"Toda verificação cita arquivo e, quando possível, símbolo; sem âncora, não sugira.",
			"Além das regras, procure riscos de consistência lógica: nome/contrato vs comportamento (ex.: `fazA` que faz `fazB`), fluxos incompletos, estados inválidos, off-by-one e bordas.",
			"Procure também riscos do domínio de negócio: transições de estado, idempotência, arredondamento, timezone, autorização, paridade de capacidade e invariantes implícitas.",
			"Sugira foco de leitura (até 5), perguntas (até 3), riscos (até 3), verificações de lógica (até 4) e de domínio (até 4).",
			"Sugira verificações, nunca afirme violação; não crie regra nova nem invente arquivo, linha ou achado.",
			"Se uma suspeita não couber em nenhuma regra, coloque-a em `logic`/`domain` como verificação ancorada.",
			"Não repita o texto literal das regras; o brief já as contém.",
		],
	);
}

/** Prompt do usuário com o contexto compactado do watchdog. */
export function briefPrompt(input: BriefPromptInput): string {
	const lines = [
		`Watchdog: ${input.name} (${input.watchdogId})`,
		`Escopo: ${input.scope}`,
		`Objetivo: ${input.description}`,
		"",
		"## Regras",
		...input.rules.map((rule) => `- [${rule.severity}] ${rule.text}`),
		"",
		`## Arquivos (${input.files.length})`,
		...input.files.slice(0, 40).map((file) => {
			const churn = input.churn?.[file];
			return `- ${file}${churn ? ` (+${churn.additions}/−${churn.deletions})` : ""}`;
		}),
	];
	if (input.context) {
		lines.push("", "## Contexto da PR");
		if (input.context.objective) lines.push(`Objetivo: ${input.context.objective}`);
		if (input.context.motivation)
			lines.push(`Motivação: ${input.context.motivation}`);
		for (const item of input.context.changeSummary ?? []) lines.push(`- ${item}`);
	}
	if (input.business) {
		const business = renderBusinessLines(input.business, {
			flows: 8,
			invariants: 8,
			contracts: 8,
			states: 4,
		});
		if (business.length > 0) lines.push("", "## Modelo de intenção", ...business);
	}
	if (input.ast && input.ast.length > 0) {
		lines.push("", "## Estrutura (AST)");
		for (const entry of input.ast) {
			const delta = entry.delta;
			lines.push(
				`- ${entry.file}: +${delta.addedSymbols.length} −${delta.removedSymbols.length} ~${delta.modifiedSymbols.length} símbolo(s)`,
			);
		}
	}
	if (input.snippets && input.snippets.length > 0) {
		lines.push("", "## Trechos alterados (diff)");
		for (const item of input.snippets.slice(0, 12)) {
			lines.push(`### ${item.file}`, "```diff", item.snippet.trimEnd(), "```");
		}
	}
	if (input.docs && input.docs.length > 0) {
		lines.push("", "## Docs disponíveis", ...input.docs.map((doc) => `- ${doc}`));
	}
	lines.push(
		"",
		"## Revisão além das regras",
		"As regras são o piso. Aponte verificações de lógica e domínio ancoradas nos",
		"trechos alterados (nome vs comportamento, estados, transições, idempotência,",
		"paridade de capacidade, credencial, bordas). Sugira verificações; não afirme",
		"violações.",
		"",
		"Produza o plano de revisão em JSON (focus, questions, risks, logic, domain).",
	);
	return lines.join("\n");
}
