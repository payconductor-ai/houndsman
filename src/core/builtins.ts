/**
 * Watchdogs embutidos do motor.
 *
 * Diferente dos watchdogs do consumidor, estes existem por padrão e não podem
 * ser desligados: são parte do fluxo de revisão. O `general` audita a lógica e o
 * domínio do diff inteiro (visão de fluxo, não de arquivo), usando o modelo de
 * intenção (`business-summary.json`) como contrato esperado.
 */

import { defineWatchdog, type WatchdogDefinition } from "./types";

/** Id reservado do revisor de lógica/domínio. */
export const GENERAL_WATCHDOG_ID = "general";

/**
 * Revisor de fluxo: recebe todos os arquivos alterados e procura gaps de
 * negócio (fluxo incompleto, capacidade não honrada, credencial divergente,
 * estado sem tratamento, identificador trocado, idempotência ausente).
 *
 * As regras são o **piso**; findings fora delas usam `Lógica:`/`Domínio:`
 * (`allowEmergentFindings`). Severidade `blocking` só é aceita com cenário +
 * evidência (normalizado no `report-builder`).
 */
export const generalWatchdog: WatchdogDefinition = defineWatchdog({
	id: GENERAL_WATCHDOG_ID,
	name: "Lógica e domínio (fluxo)",
	description:
		"Audita o fluxo alterado ponta a ponta: intenção, invariantes, estados, capacidades e credenciais.",
	scope: "Todos os arquivos alterados (visão de fluxo, independente de domínio)",
	classify: [],
	fallback: false,
	allowEmergentFindings: true,
	// Deletados não têm conteúdo para ler: entram como breaking change no brief.
	breakingChange: true,
	reviewFocus: [
		"Reconstrua o modelo de intenção (business-summary.json) antes de julgar o código.",
		"Rastreie cada símbolo alterado até seus chamadores, adapters e tipos compartilhados.",
		"Verifique paridade de capacidade: feature declarada, método exposto, evento/webhook e lista de métodos.",
		"Verifique propagação de credencial/conta/contexto em toda a cadeia (auth, token, split, subconta).",
		"Percorra o ciclo de vida completo dos fluxos tocados: criação, renovação, cancelamento, retry e erro.",
		"Confirme o identificador persistido contra a entidade que o contrato espera.",
		"Só reporte gap com gatilho concreto, comportamento observado e invariante/regra violada.",
	],
	rules: [
		{
			severity: "attention",
			text: "Promover: todo fluxo alterado tem caminho completo (criação, renovação, cancelamento) e o caminho de erro chega a um estado tratado.",
		},
		{
			severity: "attention",
			text: "Promover: toda capacidade declarada (feature, método, evento, webhook) existe e é honrada em todos os lados do contrato.",
		},
		{
			severity: "attention",
			text: "Promover: a credencial, conta e contexto de execução são os mesmos em toda a cadeia alterada (autenticação, token, split, subconta).",
		},
		{
			severity: "attention",
			text: "Promover: transições de estado e efeitos colaterais do domínio são explícitos, ordenados e idempotentes.",
		},
		{
			severity: "suggestion",
			text: "Promover: o identificador persistido corresponde à entidade que o contrato espera (cobrança, autorização, pedido, assinatura).",
		},
	],
	contextFiles: [],
});

/** Watchdogs embutidos, por id. */
export const BUILTIN_WATCHDOGS: Readonly<Record<string, WatchdogDefinition>> = {
	[GENERAL_WATCHDOG_ID]: generalWatchdog,
};

/** Definição embutida de um id (ou null). */
export function builtinWatchdog(id: string): WatchdogDefinition | null {
	return BUILTIN_WATCHDOGS[id] ?? null;
}

/**
 * Mescla a definição do consumidor com o piso embutido do `general`.
 *
 * O consumidor pode ajustar nome/escopo/docs/regras, mas não pode remover a
 * auditoria de lógica nem os findings emergentes.
 */
export function mergeGeneralWatchdog(
	configured: WatchdogDefinition | undefined,
): WatchdogDefinition {
	if (!configured || configured.id !== GENERAL_WATCHDOG_ID) return generalWatchdog;
	const rules = [...configured.rules];
	for (const rule of generalWatchdog.rules) {
		if (!rules.some((item) => item.text === rule.text)) rules.push(rule);
	}
	return {
		...generalWatchdog,
		name: configured.name || generalWatchdog.name,
		description: configured.description || generalWatchdog.description,
		scope: configured.scope || generalWatchdog.scope,
		reviewFocus: [
			...(configured.reviewFocus ?? []),
			...(generalWatchdog.reviewFocus ?? []),
		],
		exclude: configured.exclude,
		contextFiles: configured.contextFiles,
		rules,
		allowEmergentFindings: true,
		fallback: false,
	};
}
