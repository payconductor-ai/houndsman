/**
 * Cartão de um finding: dados + decisão (Executar/Ignorar), comentário e "feito".
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { DECISION_LABELS, DECISIONS, EXEC_LABELS, SEVERITY_EMOJI } from "./constants";
import type { Finding } from "./types";

export function FindingCard({
	slug,
	finding,
	onUpdated,
}: {
	slug: string;
	finding: Finding;
	onUpdated: (finding: Finding) => void;
}) {
	const [comment, setComment] = useState(finding.comment ?? "");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setComment(finding.comment ?? "");
	}, [finding.comment]);

	const patch = useCallback(
		async (body: Record<string, unknown>) => {
			setBusy(true);
			try {
				const { finding: updated } = await api<{ finding: Finding }>(
					`/api/runs/${slug}/findings/${finding.id}`,
					{
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				onUpdated(updated);
			} finally {
				setBusy(false);
			}
		},
		[finding.id, onUpdated, slug],
	);

	const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	const count = finding.count > 1 ? `×${finding.count}` : "";
	const isDone = finding.execState === "done";

	return (
		<article
			class={`card sev-${finding.severity}${finding.present ? "" : " absent"}`}
		>
			<header class="card-head">
				<span class="sev">
					{SEVERITY_EMOJI[finding.severity]} {finding.severity}
				</span>
				<code class="loc">{location}</code>
				{count && <span class="count">{count}</span>}
				<span class="spacer" />
				<code class="id" title="id do finding">
					{finding.id}
				</code>
			</header>
			<h3 class="rule">{finding.rule}</h3>
			<p class="msg">{finding.message}</p>
			<p class="action">
				<strong>Ação:</strong> {finding.action}
			</p>
			{finding.evidence && <pre class="evidence">{finding.evidence}</pre>}
			<footer class="card-foot">
				<span class="watchdogs">{finding.watchdogIds.join(", ") || "—"}</span>
				<span class="exec-state">{EXEC_LABELS[finding.execState]}</span>
			</footer>
			<div class="decisions">
				{DECISIONS.map((decision) => (
					<button
						type="button"
						title={`Marcar como ${DECISION_LABELS[decision]}`}
						class={`btn dec-${decision}${finding.decision === decision ? " active" : ""}`}
						disabled={busy}
						onClick={() =>
							patch({ decision, comment: comment.trim() || undefined })
						}
					>
						{DECISION_LABELS[decision]}
					</button>
				))}
			</div>
			<div class="comment-row">
				<textarea
					title="Comentário ou instrução adicional para o auto-fix"
					placeholder="Comentário / instrução para o auto-fix (opcional)"
					value={comment}
					onInput={(event) =>
						setComment((event.target as HTMLTextAreaElement).value)
					}
				/>
				<div class="comment-actions">
					<button
						type="button"
						title="Salvar o comentário neste finding"
						class="btn"
						disabled={busy}
						onClick={() => patch({ comment: comment.trim() })}
					>
						Salvar comentário
					</button>
					<button
						type="button"
						title="Alternar o estado de execução deste finding (feito/pendente)"
						class={`btn done${isDone ? " active" : ""}`}
						disabled={busy}
						onClick={() => patch({ execState: isDone ? "pending" : "done" })}
					>
						{isDone ? "✓ Feito" : "Marcar feito"}
					</button>
				</div>
			</div>
		</article>
	);
}
