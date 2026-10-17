/**
 * Apresentação da verificação de findings (biblioteca) — markdown do `verify`.
 */

import type { FindingsStateFile } from "../findings-state";
import type { VerifyEntry, VerifyStatus, VerifySummary } from "../verify";

/** Rótulo curto de cada status de verificação. */
const VERIFY_LABEL: Record<VerifyStatus, string> = {
	resolved: "✅ resolvido",
	persisting: "❌ persiste",
	uncertain: "⚠️ incerto",
	"file-missing": "🗑️ arquivo ausente",
};

/** Metadados do Jev exibidos no cabeçalho. */
export type VerifyMeta = { jevChecked: number; jevReason?: string };

/** Renderiza a verificação: contagem por status + uma linha por finding. */
export class VerifyPresenter {
	render(
		state: FindingsStateFile,
		entries: VerifyEntry[],
		summary: VerifySummary,
		meta: VerifyMeta,
	): string {
		if (entries.length === 0) return "Nenhum finding para verificar.";
		const lines = [
			`# Verificação — ${state.branch} (${entries.length})`,
			"",
			`Resolvidos: ${summary.resolved} · Persistem: ${summary.persisting} · Incertos: ${summary.uncertain} · Arquivo ausente: ${summary["file-missing"]}`,
		];
		if (meta.jevChecked > 0) lines.push(`Confirmados por Jev: ${meta.jevChecked}.`);
		else if (meta.jevReason) lines.push(`Jev: pulado (${meta.jevReason}).`);
		lines.push("");
		for (const entry of entries) {
			const location = entry.line ? `${entry.file}:${entry.line}` : entry.file;
			const via =
				entry.basis === "jev"
					? ` · Jev ${(entry.confidence ?? 0).toFixed(2)}`
					: "";
			lines.push(
				`- \`${entry.id}\` ${VERIFY_LABEL[entry.status]} — **${entry.severity}** \`${location}\` — ${entry.rule}${via}`,
				`  ${entry.message}`,
			);
			if (entry.detail) lines.push(`  _${entry.detail}_`);
		}
		return lines.join("\n");
	}
}
