/**
 * Validações de consistência do motor de revisão (biblioteca).
 *
 * Usado pelo subcomando `check` (`cli/index.ts`). Tudo é **inferido** do
 * `ReviewConfig` — não há caminhos de arquivo do projeto na config.
 */

import type { ReviewConfig } from "./config";
import { JevQuestionFactory } from "./jev";
import { renderReport, sanitizeBranch } from "./report-builder";
import type { ReviewerMeta } from "./types";

/** `id` da definição bate com a chave; `description` não vazio. */
function checkDefinitions(config: ReviewConfig, problems: string[]): void {
	for (const id of config.reviewerIds) {
		const def = config.reviewers[id];
		if (!def) {
			problems.push(`Revisor '${id}' sem definição em reviewers`);
			continue;
		}
		if (def.id !== id) {
			problems.push(`reviewers['${id}'].id = '${def.id}' (esperado '${id}')`);
		}
		if (!def.description.trim()) {
			problems.push(`Revisor '${id}' sem 'description'`);
		}
	}
}

/** Todo revisor precisa declarar ao menos um arquivo em `classify`. */
function checkClassification(config: ReviewConfig, problems: string[]): void {
	for (const id of config.reviewerIds) {
		const def = config.reviewers[id];
		if (!def) continue;
		if (!def.classify || def.classify.length === 0) {
			problems.push(`Revisor '${id}' não declara nenhum padrão em 'classify'`);
		}
	}
}

/** Smoke test dos helpers críticos de renderização. */
function checkRendering(config: ReviewConfig, problems: string[]): void {
	if (sanitizeBranch("feature/x") !== "feature-x") {
		problems.push("sanitizeBranch não está normalizando branches");
	}
	const sampleId = config.reviewerIds[0] ?? "reviewer";
	const report = {
		reviewerId: sampleId,
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
function checkJevSpecs(config: ReviewConfig, problems: string[]): number {
	const factory = new JevQuestionFactory(
		config.reviewers as Record<string, ReviewerMeta>,
	);
	let generated = 0;
	const keys = new Set<string>();

	for (const id of config.reviewerIds) {
		const def = config.reviewers[id];
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
function checkRulePolarity(config: ReviewConfig, warnings: string[]): void {
	for (const id of config.reviewerIds) {
		const def = config.reviewers[id];
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

export function checkRegistry(config: ReviewConfig): {
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
	const jevQuestions = checkJevSpecs(config, problems);

	return { problems, warnings, jevQuestions };
}
