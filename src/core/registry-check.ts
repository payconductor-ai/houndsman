/**
 * Validações de consistência do motor de revisão (biblioteca).
 *
 * Usado pelo subcomando `check` (`cli/index.ts`). Tudo é **inferido** do
 * `HoundsmanConfig` — não há caminhos de arquivo do projeto na config.
 */

import type { HoundsmanConfig } from "./config";
import { env } from "./env";
import { JevQuestionFactory } from "./jev";
import { renderReport, sanitizeBranch } from "./report-builder";
import { hasExplicitPolarity } from "./rule-text";
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

/** Todo watchdog precisa declarar ao menos um arquivo em `classify` (fallback isento). */
function checkClassification(config: HoundsmanConfig, problems: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		if (def.fallback) continue;
		if (!def.classify || def.classify.length === 0) {
			problems.push(`Watchdog '${id}' não declara nenhum padrão em 'classify'`);
		}
	}
}

/** Fallback: no máximo um; `classify` é ignorado; precisa de regras. */
function checkFallbacks(config: HoundsmanConfig, warnings: string[]): void {
	const fallbacks = config.watchdogIds.filter(
		(id) => config.watchdogs[id]?.fallback === true,
	);
	if (fallbacks.length > 1) {
		warnings.push(
			`Mais de um watchdog fallback (${fallbacks.join(", ")}); o primeiro declarado vence.`,
		);
	}
	for (const id of fallbacks) {
		const def = config.watchdogs[id];
		if (!def) continue;
		if (def.classify && def.classify.length > 0) {
			warnings.push(`watchdogs['${id}'] é fallback — 'classify' é ignorado.`);
		}
		if (def.rules.length === 0) {
			warnings.push(`Watchdog fallback '${id}' não declara nenhuma regra.`);
		}
	}
}

/** Findings emergentes exigem ao menos uma regra de lógica/domínio como piso. */
function checkEmergent(config: HoundsmanConfig, warnings: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def?.allowEmergentFindings) continue;
		const hasGeneric = def.rules.some((rule) =>
			/l[oó]gica|dom[ií]nio/i.test(rule.text),
		);
		if (!hasGeneric) {
			warnings.push(
				`watchdogs['${id}'].allowEmergentFindings sem regra de lógica/domínio — o piso fica implícito.`,
			);
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
			if (!text || hasExplicitPolarity(text)) return;
			warnings.push(
				`Regra sem polaridade explícita em ${id} (rule-${index}): ${rule.text}`,
			);
		});
	}
}

/** Normaliza o texto da regra para detectar duplicatas (case/espaços). */
function normalizeRuleText(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Aviso para regra repetida (texto normalizado) no mesmo watchdog — a regra deve
 * existir uma única vez em `rules` (§ Convenções de escrita, item 10).
 */
function checkRuleDuplication(config: HoundsmanConfig, warnings: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		const seen = new Set<string>();
		def.rules.forEach((rule, index) => {
			const key = normalizeRuleText(rule.text);
			if (!key) return;
			if (seen.has(key)) {
				warnings.push(`Regra duplicada em ${id} (rule-${index}): ${rule.text}`);
				return;
			}
			seen.add(key);
		});
	}
}

/** Campos de metadados que NÃO devem conter texto de regra. */
const RULE_BEARING_FIELDS = ["reviewFocus", "contextFiles", "exclude"] as const;

/**
 * Aviso quando `reviewFocus`/`contextFiles`/`exclude` recebem texto de regra
 * (prefixo de polaridade) — a regra vive só em `rules`; duplicá-la nesses campos
 * deixa o brief do subagente redundante.
 */
function checkMetadataPrecision(config: HoundsmanConfig, warnings: string[]): void {
	for (const id of config.watchdogIds) {
		const def = config.watchdogs[id];
		if (!def) continue;
		for (const field of RULE_BEARING_FIELDS) {
			const items = def[field];
			if (!items) continue;
			items.forEach((item, index) => {
				if (!hasExplicitPolarity(item)) return;
				warnings.push(
					`Texto de regra em ${id}.${field}[${index}] — a regra vive só em 'rules': ${item}`,
				);
			});
		}
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

/** Valida a configuração do AST (a disponibilidade das grammars é checada no doctor). */
function checkAstConfig(
	config: HoundsmanConfig,
	problems: string[],
	warnings: string[],
): void {
	const ast = config.ast;
	if (!ast) return;

	if (ast.maxFileBytes !== undefined && ast.maxFileBytes <= 0) {
		warnings.push(
			`ast.maxFileBytes = ${ast.maxFileBytes} — não-positivo; usando o default.`,
		);
	}
	if (ast.maxImpactFiles !== undefined && ast.maxImpactFiles < 0) {
		warnings.push(
			`ast.maxImpactFiles = ${ast.maxImpactFiles} — negativo; impacto será desabilitado.`,
		);
	}
	const valid = new Set(["typescript", "tsx", "javascript"]);
	for (const [extension, language] of Object.entries(ast.languages ?? {})) {
		if (!valid.has(language)) {
			problems.push(
				`ast.languages['${extension}'] = '${language}' (esperado typescript|tsx|javascript)`,
			);
		}
	}
	for (const [alias, target] of Object.entries(ast.aliases ?? {})) {
		if (!alias.trim() || !target.trim()) {
			warnings.push(`ast.aliases['${alias}'] vazio — alias ignorado.`);
		}
	}
}

/** Valida a configuração de IA (sem exigir chave — fail-open). */
function checkAiConfig(
	config: HoundsmanConfig,
	problems: string[],
	warnings: string[],
): void {
	const ai = config.ai;
	if (!ai) return;

	const validProviders = new Set(["deepseek", "openai", "anthropic"]);
	if (ai.provider !== undefined && !validProviders.has(ai.provider)) {
		problems.push(
			`ai.provider = '${ai.provider}' (esperado deepseek|openai|anthropic)`,
		);
	}
	if (ai.enabled !== false && ai.model !== undefined && !ai.model.trim()) {
		warnings.push("ai.model vazio — usando o default.");
	}
	for (const key of ["concurrency", "timeoutMs"] as const) {
		const value = ai[key];
		if (value !== undefined && value <= 0) {
			warnings.push(`ai.${key} = ${value} — não-positivo; usando o default.`);
		}
	}
	if (ai.maxCallsPerReview !== undefined && ai.maxCallsPerReview <= 0) {
		warnings.push(
			`ai.maxCallsPerReview = ${ai.maxCallsPerReview} — não-positivo; usando o default.`,
		);
	}
	if (ai.maxTokensPerReview !== undefined && ai.maxTokensPerReview < 0) {
		warnings.push(
			`ai.maxTokensPerReview = ${ai.maxTokensPerReview} — negativo; sem teto.`,
		);
	}
	for (const id of Object.keys(ai.watchdogs ?? {})) {
		if (!config.watchdogIds.includes(id)) {
			warnings.push(`ai.watchdogs['${id}'] não corresponde a nenhum watchdog.`);
		}
	}

	const provider = ai.provider ?? "deepseek";
	if (validProviders.has(provider) && ai.enabled !== false) {
		const credential =
			provider === "deepseek"
				? env.deepSeekApiKey
				: provider === "openai"
					? env.openAiApiKey
					: env.anthropicApiKey;
		if (!credential) {
			warnings.push(
				`ai.provider '${provider}' sem credencial — features de IA ficam fail-open.`,
			);
		}
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
	checkFallbacks(config, warnings);
	checkEmergent(config, warnings);
	checkRendering(config, problems);
	checkRulePolarity(config, warnings);
	checkRuleDuplication(config, warnings);
	checkMetadataPrecision(config, warnings);
	checkBudgets(config, warnings);
	checkAstConfig(config, problems, warnings);
	checkAiConfig(config, problems, warnings);
	const jevQuestions = checkJevSpecs(config, problems);

	return { problems, warnings, jevQuestions };
}
