/**
 * Prompt do estado VERIFY (crítica refutadora).
 *
 * O crítico determinístico é o default; este prompt fica disponível para um
 * crítico por IA, que deve tentar **derrubar** cada draft.
 */

import type { FindingDraft } from "../../investigation/evidence";

/** Prompt de refutação. */
export function verifyPrompt(drafts: readonly FindingDraft[]): string {
	return [
		"Tente refutar cada draft abaixo.",
		"Responda `keep` apenas se a evidência sustenta a violação.",
		"Use `downgrade` quando a evidência sustenta algo mais leve.",
		...drafts.map(
			(draft) =>
				`- ${draft.rule} · ${draft.file}:${draft.line ?? "?"} · confiança ${draft.confidence}`,
		),
		"Produza JSON com `decisions`.",
	].join("\n");
}
