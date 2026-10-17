/**
 * Prompt do estado CONCLUDE (documentação do contrato).
 *
 * A conclusão do harness é determinística (bits de evidência/coverage); este
 * texto existe para manter o contrato explícito e servir a um futuro modo
 * "conclude por modelo".
 */

/** Instruções de conclusão. */
export function concludePrompt(): string {
	return [
		"Conclua com base apenas nos drafts sobreviventes ao VERIFY.",
		"Não adicione achados novos.",
		"Toda regra sem achado deve constar como coverage checked/not_applicable/skipped.",
	].join("\n");
}
