/**
 * Validações de consistência do motor de revisão (biblioteca).
 *
 * Usado pelo subcomando `check` (`cli/index.ts`). Tudo é **inferido** do
 * `HoundsmanConfig` — não há caminhos de arquivo do projeto na config.
 */

import type { HoundsmanConfig } from "./config";
import { JevQuestionFactory } from "./jev";
import { renderReport, sanitizeBranch } from "./report-builder";
import type { WatchdogMeta } from "./types";

/** `id` da definição bate com a chave; `description` não vazio. */
function checkDefinitions(config: HoundsmanConfig, problems: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) {
			problems.push(`Watchdog '${id}' sem definição em watchdogs`);
			continue;
		}
		if (def.id !== id) {
			problems.push(`watchdogs['${id}'].id = '${def.id}' (esperado '${id}')`);
		}
		if (!def.description.trim()) {
			problems.push(`Watchdog '${id}' sem 'description'`);
		}
	}
}

/** Todo watchdog precisa declarar ao menos um arquivo em `classify`. */
function checkClassification(config: HoundsmanConfig, problems: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		if (!def.classify || def.classify.length === 0) {
			problems.push(`Watchdog '${id}' não declara nenhum padrão em 'classify'`);
		}
	}
}

/** Smoke test dos helpers críticos de renderização. */
function checkRendering(config: HoundsmanConfig, problems: string[]): void {
	if (sanitizeBranch("feature/x") !== "feature-x") {
		problems.push("sanitizeBranch não está normalizando branches");
	}
	const sampleId = config.watchdogIds[0] ?? "watchdog";
	const report = {
		watchdogId: sampleId,
		reviewedFiles: [],
		skipped: [],
		findings: [],
	};
	const md = renderReport("main", [report], [], {});
	if (!md.includes("✅ Aprovado")) {
		problems.push("renderReport não marcou status aprovado sem achados");
	}
	const withContext = renderReport(
		"main",
		[report],
		[],
		{},
		{
			available: true,
			objective: "Entregar X",
			changeSummary: ["Faz A"],
		},
	);
	if (!withContext.includes("## Contexto da PR")) {
		problems.push("renderReport não incluiu a seção de contexto");
	}
}

/** Valida as specs Jev da config e conta as perguntas derivadas. */
function checkJevSpecs(config: HoundsmanConfig, problems: string[]): number {
	const factory = new JevQuestionFactory(
		config.watchdogs as Record<string, WatchdogMeta>,
	);
	let generated = 0;
	const keys = new Set<string>();

	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		def.rules.forEach((rule, index) => {
			const key = `${id}::rule-${index}`;
			if (!rule.text.trim()) {
				problems.push(`Regra sem texto em ${id} (rule-${index})`);
			}
			const spec = factory.specOf(rule);
			if (!spec) return;
			const question = factory.fromSpec(rule.text, spec);
			if (!question) {
				problems.push(`Spec Jev inválida em ${id} (rule-${index}): ${rule.text}`);
				return;
			}
			generated++;
			if (keys.has(key)) problems.push(`Chave Jev duplicada: ${key}`);
			keys.add(key);
			if (!question.instructions.trim()) {
				problems.push(`Pergunta Jev sem instrução: ${key}`);
			}
		});
	}

	// Jev é opcional (falha-aberto): não ter perguntas não é erro de configuração.
	return generated;
}

/** Prefixos de polaridade aceitos no texto da regra (§ Convenções de escrita). */
const POLARITY_PREFIX = /^(promover|evitar|não|nao|nunca)\b/i;

/**
 * Aviso **não bloqueante** para regra sem polaridade explícita: o texto deve
 * começar com `Promover:` (DEVE acontecer) ou `Evitar:`/`Não`/`Nunca` (NÃO DEVE).
 */
function checkRulePolarity(config: HoundsmanConfig, warnings: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		def.rules.forEach((rule, index) => {
			const text = rule.text.trim();
			if (!text || POLARITY_PREFIX.test(text)) return;
			warnings.push(
				`Regra sem polaridade explícita em ${id} (rule-${index}): ${rule.text}`,
			);
		});
	}
}

/** Aviso para orçamento/concorrência inválidos — o motor cai no default. */
function checkBudgets(config: HoundsmanConfig, warnings: string[]): void {
	const maxFiles = config.budgets?.maxFilesPerBrief;
	if (maxFiles !== undefined && maxFiles <= 0) {
		warnings.push(
			`budgets.maxFilesPerBrief = ${maxFiles} — não-positivo; usando o default.`,
		);
	}
	const jev = config.concurrency?.jev;
	if (jev !== undefined && jev <= 0) {
		warnings.push(`concurrency.jev = ${jev} — não-positivo; usando o default.`);
	}
}

export function checkRegistry(config: HoundsmanConfig): {
	problems: string[];
	warnings: string[];
	jevQuestions: number;
} {
	const problems: string[] = [];
	const warnings: string[] = [];

	checkDefinitions(config, problems);
	checkClassification(config, problems);
	checkRendering(config, problems);
	checkRulePolarity(config, warnings);
	checkBudgets(config, warnings);
	const jevQuestions = checkJevSpecs(config, problems);

	return { problems, warnings, jevQuestions };
}
