/**
 * Modelo de intenção da PR (`business-summary.json`).
 *
 * Descreve o que a mudança **promete** entregar — fluxos, invariantes, contratos
 * e estados — antes de qualquer watchdog julgar o código. É insumo obrigatório
 * do revisor `general`: sem ele a revisão volta a caçar só violações de regra.
 *
 * Produtores, em ordem de precedência:
 *   1. `ai`            — `AiBusinessSummarizer` no prepare (quando há chave).
 *   2. `reviewer`      — subagente (skill) ou pré-passe maki (`houndsman hunt`).
 *   3. `deterministic` — fallback montado a partir de AST/churn/contexto.
 */

import type { AstAnalysis, AstImpact, AstSymbolKind } from "./ast/types";
import { GENERAL_WATCHDOG_ID } from "./builtins";
import type { ChangedScope } from "./changed-scope";
import type { ClassificationResult } from "./file-classifier";

/** Fluxo de negócio tocado pela mudança. */
export type BusinessFlow = {
	name: string;
	/** O que dispara o fluxo (endpoint, evento, job, ação do usuário). */
	trigger?: string;
	/** Comportamento esperado ao final do fluxo. */
	expected?: string;
	/** Arquivos envolvidos (para o revisor rastrear). */
	files?: string[];
};

/** Contrato/paridade entre lados (provider × orquestrador, adapter × tipo). */
export type BusinessContract = {
	name: string;
	/** Lados que precisam concordar (ex.: `asaas`, `charge-processor`). */
	sides?: string[];
	/** O que precisa ser verdadeiro em todos os lados. */
	expectation?: string;
};

/** Estados e transições relevantes do domínio. */
export type BusinessState = {
	name: string;
	transitions?: string[];
};

/** Fonte do modelo de intenção. */
export type BusinessSummarySource = "ai" | "reviewer" | "deterministic";

/** Modelo de intenção de uma revisão. */
export type BusinessSummary = {
	source: BusinessSummarySource;
	/** Commit coberto — permite saber a que revisão o modelo se refere. */
	headSha?: string;
	/** O que a PR promete entregar (1 parágrafo curto). */
	intent?: string;
	flows: BusinessFlow[];
	invariants: string[];
	contracts: BusinessContract[];
	states: BusinessState[];
	/** O que a PR explicitamente não se propõe a fazer. */
	nonGoals?: string[];
	/** Pontos que o revisor deve confirmar com o autor. */
	openQuestions?: string[];
};

/** Entrada do builder determinístico (não lê disco). */
export type BusinessInput = {
	classification: Pick<ClassificationResult, "files" | "churn" | "watchdogs">;
	/** Domínios ativos (id + nome legível). */
	domains?: readonly { id: string; name: string }[];
	ast?: ReadonlyMap<string, AstAnalysis>;
	impact?: AstImpact;
	changedScope?: ChangedScope;
	headSha?: string;
	context?: {
		objective?: string;
		motivation?: string;
		changeSummary?: string[];
	} | null;
	/** Patch por arquivo (`diff.byFile`) — usado no payload da IA. */
	snippets?: ReadonlyMap<string, string>;
};

const MAX_FLOWS = 12;
const MAX_INVARIANTS = 12;
const MAX_CONTRACTS = 12;
const MAX_STATES = 8;
const MAX_FILES_PER_FLOW = 20;
const MAX_SYMBOLS_PER_FLOW = 6;
const MAX_PROMPT_FILES = 40;
const MAX_SNIPPET_CHARS = 1_200;

/** Corta o texto em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `true` para símbolos que representam contratos. */
function isContract(kind: AstSymbolKind): boolean {
	return kind === "interface" || kind === "type" || kind === "enum";
}

/** Símbolos alterados de um arquivo (adicionados/alterados), sem duplicatas. */
function changedSymbolNames(analysis: AstAnalysis | undefined): string[] {
	const delta = analysis?.delta;
	if (!delta) return [];
	const seen = new Set<string>();
	const names: string[] = [];
	for (const symbol of [...delta.addedSymbols, ...delta.modifiedSymbols]) {
		if (seen.has(symbol.name)) continue;
		seen.add(symbol.name);
		names.push(symbol.name);
	}
	return names;
}

/** Indica se o arquivo está entre os alterados com conteúdo revisável. */
function orderByChurn(
	files: readonly string[],
	churn: ClassificationResult["churn"],
): string[] {
	return [...files].sort((a, b) => {
		const ca = (churn[a]?.additions ?? 0) + (churn[a]?.deletions ?? 0);
		const cb = (churn[b]?.additions ?? 0) + (churn[b]?.deletions ?? 0);
		return cb - ca || a.localeCompare(b);
	});
}

/**
 * Monta o modelo determinístico: agrupa por domínio, lista símbolos alterados e
 * extrai contratos declarados. Nunca inventa invariantes nem fluxos de negócio
 * (isso exige leitura do diff — papel da IA/subagente).
 */
export function buildBusinessSummary(input: BusinessInput): BusinessSummary {
	const flowDomains = (input.domains ?? []).filter(
		(domain) => domain.id !== GENERAL_WATCHDOG_ID,
	);

	const flows: BusinessFlow[] = [];
	for (const domain of flowDomains) {
		const files = orderByChurn(
			input.classification.watchdogs[domain.id] ?? [],
			input.classification.churn,
		).slice(0, MAX_FILES_PER_FLOW);
		if (files.length === 0) continue;
		const symbols = new Set<string>();
		for (const file of files) {
			for (const name of changedSymbolNames(input.ast?.get(file))) {
				if (symbols.size >= MAX_SYMBOLS_PER_FLOW) break;
				symbols.add(name);
			}
		}
		flows.push({
			name: domain.name,
			files,
			expected:
				symbols.size > 0
					? `Símbolos alterados: ${[...symbols].join(", ")}`
					: undefined,
		});
		if (flows.length >= MAX_FLOWS) break;
	}

	const contracts: BusinessContract[] = [];
	const seenContracts = new Set<string>();
	if (input.ast) {
		for (const [file, analysis] of input.ast) {
			const added = analysis.delta?.addedSymbols ?? [];
			for (const symbol of added) {
				if (!isContract(symbol.kind)) continue;
				const key = `${symbol.name}|${file}`;
				if (seenContracts.has(key)) continue;
				seenContracts.add(key);
				contracts.push({
					name: symbol.name,
					sides: [file],
					expectation: `Declaração \`${symbol.kind}\` nova — verificar se todos os lados do contrato a honram.`,
				});
				if (contracts.length >= MAX_CONTRACTS) break;
			}
			if (contracts.length >= MAX_CONTRACTS) break;
		}
	}

	return {
		source: "deterministic",
		headSha: input.headSha,
		intent:
			input.context?.objective?.trim() ||
			input.context?.motivation?.trim() ||
			undefined,
		flows,
		invariants: [],
		contracts,
		states: [],
	};
}

/** Texto curto usado no brief e no manifesto. */
export function summarizeBusiness(business: BusinessSummary): {
	flows: number;
	invariants: number;
	contracts: number;
	states: number;
} {
	return {
		flows: business.flows.length,
		invariants: business.invariants.length,
		contracts: business.contracts.length,
		states: business.states.length,
	};
}

/** Payload compacto enviado ao modelo (nunca arquivos inteiros). */
export function buildBusinessPromptPayload(
	input: BusinessInput,
): Record<string, unknown> {
	const files = Object.entries(input.classification.files)
		.map(([path, file]) => {
			const churn = input.classification.churn[path];
			const scope = input.changedScope?.[path];
			return {
				path,
				status: file.status,
				additions: churn?.additions ?? 0,
				deletions: churn?.deletions ?? 0,
				symbols: changedSymbolNames(input.ast?.get(path)).slice(
					0,
					MAX_SYMBOLS_PER_FLOW,
				),
				ranges:
					scope?.ranges.map((range) =>
						range.start === range.end
							? `${range.start}`
							: `${range.start}-${range.end}`,
					) ?? [],
				importedBy: input.impact?.importers[path]?.slice(0, 8) ?? [],
				snippet: input.snippets
					? truncate(input.snippets.get(path) ?? "", MAX_SNIPPET_CHARS)
					: undefined,
			};
		})
		.sort(
			(a, b) =>
				b.additions + b.deletions - (a.additions + a.deletions) ||
				a.path.localeCompare(b.path),
		)
		.slice(0, MAX_PROMPT_FILES);

	return {
		headSha: input.headSha,
		context: input.context
			? {
					objective: input.context.objective,
					motivation: input.context.motivation,
					changeSummary: input.context.changeSummary,
				}
			: undefined,
		domains: (input.domains ?? []).map((domain) => domain.name),
		files,
		deterministic: {
			intent:
				input.context?.objective?.trim() ||
				input.context?.motivation?.trim() ||
				undefined,
			contracts: buildBusinessSummary(input).contracts,
		},
	};
}

/** Normaliza uma lista de strings com limite de tamanho/quantidade. */
function normalizeList(
	value: unknown,
	max: number,
	maxLength: number,
): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((item) => (typeof item === "string" ? truncate(item, maxLength) : ""))
		.filter((item) => item.length > 0)
		.slice(0, max);
	return items.length > 0 ? items : undefined;
}

/**
 * Valida/normaliza o `business-summary.json`. `null` quando não há conteúdo
 * útil (nem intenção, nem fluxo, nem contrato).
 */
export function parseBusinessSummary(
	raw: unknown,
	source: BusinessSummarySource = "deterministic",
	headSha?: string,
): BusinessSummary | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;

	const intent =
		typeof obj.intent === "string" && obj.intent.trim().length > 0
			? truncate(obj.intent, 800)
			: undefined;

	const flows: BusinessFlow[] = [];
	if (Array.isArray(obj.flows)) {
		for (const item of obj.flows) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			const name = typeof entry.name === "string" ? entry.name.trim() : "";
			if (!name) continue;
			flows.push({
				name: truncate(name, 120),
				trigger:
					typeof entry.trigger === "string"
						? truncate(entry.trigger, 240)
						: undefined,
				expected:
					typeof entry.expected === "string"
						? truncate(entry.expected, 400)
						: undefined,
				files: normalizeList(entry.files, MAX_FILES_PER_FLOW, 200),
			});
			if (flows.length >= MAX_FLOWS) break;
		}
	}

	const contracts: BusinessContract[] = [];
	if (Array.isArray(obj.contracts)) {
		for (const item of obj.contracts) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			const name = typeof entry.name === "string" ? entry.name.trim() : "";
			if (!name) continue;
			contracts.push({
				name: truncate(name, 120),
				sides: normalizeList(entry.sides, 8, 160),
				expectation:
					typeof entry.expectation === "string"
						? truncate(entry.expectation, 400)
						: undefined,
			});
			if (contracts.length >= MAX_CONTRACTS) break;
		}
	}

	const states: BusinessState[] = [];
	if (Array.isArray(obj.states)) {
		for (const item of obj.states) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			const name = typeof entry.name === "string" ? entry.name.trim() : "";
			if (!name) continue;
			states.push({
				name: truncate(name, 120),
				transitions: normalizeList(entry.transitions, 12, 200),
			});
			if (states.length >= MAX_STATES) break;
		}
	}

	const invariants = normalizeList(obj.invariants, MAX_INVARIANTS, 300) ?? [];
	const nonGoals = normalizeList(obj.nonGoals, 8, 240);
	const openQuestions = normalizeList(obj.openQuestions, 8, 300);

	if (
		!intent &&
		flows.length === 0 &&
		contracts.length === 0 &&
		invariants.length === 0
	) {
		return null;
	}

	return {
		source: obj.source === "ai" || obj.source === "reviewer" ? obj.source : source,
		headSha: typeof obj.headSha === "string" ? obj.headSha : headSha,
		intent,
		flows,
		invariants,
		contracts,
		states,
		nonGoals,
		openQuestions,
	};
}

/** Linhas compactas do modelo de intenção (brief e resumo). */
export function renderBusinessLines(
	business: BusinessSummary,
	limits = { flows: 6, invariants: 6, contracts: 6, states: 4 },
): string[] {
	const lines: string[] = [];
	if (business.intent) lines.push(`**Intenção:** ${truncate(business.intent, 400)}`);
	if (business.invariants.length > 0) {
		lines.push("", "**Invariantes:**");
		for (const item of business.invariants.slice(0, limits.invariants)) {
			lines.push(`- ${truncate(item, 240)}`);
		}
	}
	if (business.flows.length > 0) {
		lines.push("", `**Fluxos (${business.flows.length}):**`);
		for (const flow of business.flows.slice(0, limits.flows)) {
			const parts = [`- **${truncate(flow.name, 100)}**`];
			if (flow.trigger) parts.push(`disparo: ${truncate(flow.trigger, 160)}`);
			if (flow.expected) parts.push(`esperado: ${truncate(flow.expected, 240)}`);
			lines.push(parts.join(" — "));
			if (flow.files && flow.files.length > 0) {
				lines.push(`  arquivos: ${flow.files.slice(0, 6).join(", ")}`);
			}
		}
	}
	if (business.contracts.length > 0) {
		lines.push("", `**Contratos (${business.contracts.length}):**`);
		for (const contract of business.contracts.slice(0, limits.contracts)) {
			const sides = contract.sides?.slice(0, 4).join(" × ") ?? "";
			const expectation = contract.expectation
				? ` — ${truncate(contract.expectation, 240)}`
				: "";
			lines.push(
				`- **${truncate(contract.name, 100)}**${sides ? ` (${sides})` : ""}${expectation}`,
			);
		}
	}
	if (business.states.length > 0) {
		lines.push("", "**Estados:**");
		for (const state of business.states.slice(0, limits.states)) {
			const transitions = state.transitions?.slice(0, 6).join(" → ") ?? "";
			lines.push(
				`- ${truncate(state.name, 100)}${transitions ? `: ${truncate(transitions, 240)}` : ""}`,
			);
		}
	}
	if (business.openQuestions && business.openQuestions.length > 0) {
		lines.push("", "**Pontos a confirmar:**");
		for (const item of business.openQuestions.slice(0, 4)) {
			lines.push(`- ${truncate(item, 240)}`);
		}
	}
	return lines;
}

/** Schema textual do output (repetido no brief e no harness maki). */
export const BUSINESS_SUMMARY_SCHEMA = `{
  "intent": "o que a PR promete entregar (1 parágrafo)",
  "flows": [
    { "name": "fluxo", "trigger": "o que dispara", "expected": "resultado esperado", "files": ["caminho/relativo.ts"] }
  ],
  "invariants": ["o que precisa ser verdadeiro sempre"],
  "contracts": [
    { "name": "contrato/capacidade", "sides": ["lado A", "lado B"], "expectation": "o que os lados precisam honrar" }
  ],
  "states": [{ "name": "estado", "transitions": ["A → B"] }],
  "nonGoals": ["fora do escopo"],
  "openQuestions": ["o que precisa ser confirmado"]
}`;

export type BusinessBriefInput = {
	projectName: string;
	branch: string;
	headSha?: string;
	outputPath: string;
	/** Modelo determinístico já montado (ponto de partida). */
	business: BusinessSummary;
	/** Arquivos + escopo + churn para orientar a leitura. */
	files: readonly {
		path: string;
		status: string;
		ranges?: readonly { start: number; end: number }[];
		symbols?: readonly string[];
	}[];
	docs?: readonly string[];
	context?: {
		objective?: string;
		motivation?: string;
		changeSummary?: string[];
	} | null;
};

/**
 * Brief do passo de intenção. Executado por subagente (skill) ou por pré-passe
 * maki (`houndsman hunt`) — o output é o mesmo `BusinessSummary`.
 */
export function buildBusinessBrief(input: BusinessBriefInput): string {
	const lines: string[] = [
		`# Brief — Intenção da PR (\`business\`)`,
		"",
		`**Projeto:** ${input.projectName}`,
		`**Branch:** ${input.branch}`,
		...(input.headSha ? [`**Commit:** \`${input.headSha.slice(0, 7)}\``] : []),
		`**Output obrigatório:** \`${input.outputPath}\``,
		"",
		"## Papel",
		"",
		"Você reconstrói **o que esta PR promete entregar** antes de qualquer watchdog",
		"julgar o código. Leia o diff real (não só a descrição da PR) e produza um",
		"modelo de intenção verificável. **Não produza achados** — este passo não revisa.",
		"",
		"## Schema do output",
		"",
		"```json",
		BUSINESS_SUMMARY_SCHEMA,
		"```",
		"",
		"## Procedimento",
		"",
		"1. **INTENT** — em 1 parágrafo, o comportamento que a PR deve entregar.",
		"2. **FLOWS** — cada fluxo tocado (criação, renovação, cancelamento, webhook,",
		"   retry, transferência…) com disparo, resultado esperado e arquivos.",
		"3. **INVARIANTS** — o que precisa valer sempre (paridade de capacidade,",
		"   credencial/conta correta, idempotência, estado consistente).",
		"4. **CONTRACTS** — capacidades/interfaces e os lados que precisam concordar.",
		"5. **STATES** — estados e transições afetados.",
		"",
		"Use apenas o que estiver no diff/arquivos do escopo. Se algo não estiver claro,",
		"registre em `openQuestions` em vez de inventar.",
		"",
	];

	if (input.context) {
		lines.push("## Contexto da PR", "");
		if (input.context.objective)
			lines.push(`**Objetivo:** ${input.context.objective}`);
		if (input.context.motivation)
			lines.push(`**Motivação:** ${input.context.motivation}`);
		for (const item of input.context.changeSummary ?? []) lines.push(`- ${item}`);
		lines.push("");
	}

	const starting = renderBusinessLines(input.business, {
		flows: 12,
		invariants: 12,
		contracts: 12,
		states: 8,
	});
	if (starting.length > 0) {
		lines.push(
			"## Modelo determinístico (ponto de partida)",
			"",
			"> Derivado de AST/churn/contexto. Confirme, corrija e complete com o diff real.",
			"",
			...starting,
			"",
		);
	}

	lines.push(`## Arquivos do escopo (${input.files.length})`, "");
	for (const file of input.files.slice(0, 60)) {
		const ranges =
			file.ranges && file.ranges.length > 0
				? ` — linhas ${file.ranges
						.map((range) =>
							range.start === range.end
								? `${range.start}`
								: `${range.start}-${range.end}`,
						)
						.join(", ")}`
				: "";
		lines.push(`- \`${file.path}\` (${file.status})${ranges}`);
		if (file.symbols && file.symbols.length > 0) {
			lines.push(`  símbolos: ${file.symbols.slice(0, 8).join(", ")}`);
		}
	}
	if (input.files.length > 60) lines.push(`- … +${input.files.length - 60}`);
	lines.push("");

	if (input.docs && input.docs.length > 0) {
		lines.push(
			"## Docs de contexto",
			"",
			...input.docs.map((doc) => `- \`${doc}\``),
			"",
		);
	}

	lines.push(
		"## Regra de escopo",
		"",
		"> Só considere o que o diff alterou. Código fora das faixas é contexto,",
		"> nunca um fluxo novo desta PR.",
		"",
		`Grave o JSON em \`${input.outputPath}\` com \`source: "reviewer"\`.`,
	);

	return `${lines.join("\n")}\n`;
}
