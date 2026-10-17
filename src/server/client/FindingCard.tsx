/**
 * Cartão de um finding: identidade (severidade + local), ação recomendada,
 * evidência, watchdogs, decisão segmentada e comentário com auto-save.
 *
 * Colapso: marcar como feito recolhe o cartão (título tachado) para limpar a
 * poluição visual da triagem; reabrir volta a expandir.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api";
import { highlightCode, languageFromFile } from "./code-highlight";
import { DECISION_LABELS, DECISIONS, SEVERITY_LABELS } from "./constants";
import { vscodeFileLink } from "./format";
import {
	Check,
	ChevronRight,
	CodeIcon,
	ExternalLink,
	Sparkles,
	Spinner,
	Watch,
} from "./icons";
import { MarkdownText } from "./MarkdownText";
import type { Finding } from "./types";

/** Debounce do auto-save do comentário (ms). */
const AUTOSAVE_MS = 700;
/** Tempo que o "✓ Salvo" fica visível antes de voltar ao estado neutro (ms). */
const SAVED_VISIBLE_MS = 1800;

export function FindingCard({
	slug,
	finding,
	onUpdated,
}: {
	slug: string;
	finding: Finding;
	onUpdated: (finding: Finding) => void;
}) {
	const isDone = finding.execState === "done";
	const [open, setOpen] = useState(!isDone);
	const [busy, setBusy] = useState(false);
	const [comment, setComment] = useState(finding.comment ?? "");
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
	/** Último valor confirmado pelo servidor — evita sobrescrever o que foi digitado. */
	const savedRef = useRef(finding.comment ?? "");

	// O cartão acompanha o estado de execução: feito colapsa, reaberto expande.
	useEffect(() => {
		setOpen(finding.execState !== "done" && finding.decision !== "ignore");
	}, [isDone]);

	// Só reidrata o comentário quando o servidor tem um valor novo e nada local pendente.
	useEffect(() => {
		const incoming = finding.comment ?? "";
		if (incoming === savedRef.current) return;
		savedRef.current = incoming;
		setComment(incoming);
	}, [finding.comment]);

	useEffect(() => {
		if (saveState !== "saved") return;
		const id = setTimeout(() => setSaveState("idle"), SAVED_VISIBLE_MS);
		return () => clearTimeout(id);
	}, [saveState]);

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
				return updated;
			} finally {
				setBusy(false);
			}
		},
		[finding.id, onUpdated, slug],
	);

	// Auto-save do comentário (debounce): nada a salvar = nada a fazer.
	useEffect(() => {
		const value = comment.trim();
		if (value === savedRef.current.trim()) return;
		setSaveState("saving");
		const id = setTimeout(async () => {
			try {
				await patch({ comment: value });
				savedRef.current = value;
				setSaveState("saved");
			} catch {
				setSaveState("idle");
			}
		}, AUTOSAVE_MS);
		return () => clearTimeout(id);
	}, [comment, patch]);

	const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	const href = finding.absFile ? vscodeFileLink(finding.absFile, finding.line) : null;
	const highlighted = useMemo(
		() =>
			finding.evidence
				? highlightCode(finding.evidence, languageFromFile(finding.file))
				: null,
		[finding.evidence, finding.file],
	);
	const toggle = () => setOpen((current) => !current);

	return (
		<article
			class={`card sev-${finding.severity}${finding.present ? "" : " absent"}${
				isDone ? " done" : ""
			}`}
		>
			<div class="card-head">
				<button
					type="button"
					class={`chev${open ? " open" : ""}`}
					aria-expanded={open}
					title={open ? "Recolher finding" : "Expandir finding"}
					onClick={toggle}
				>
					<ChevronRight size={16} />
				</button>
				<span class="sev-badge">{SEVERITY_LABELS[finding.severity]}</span>
				{href ? (
					<a class="loc" href={href} title={`Abrir ${location} no VS Code`}>
						<CodeIcon size={13} />
						{location}
						<ExternalLink size={12} class="ext" />
					</a>
				) : (
					<code class="loc static" title={location}>
						<CodeIcon size={13} />
						{location}
					</code>
				)}
				{finding.count > 1 && (
					<span class="count" title="ocorrências idênticas colapsadas">
						×{finding.count}
					</span>
				)}
				{!finding.present && (
					<span class="tag" title="Não aparece no último relatório consolidado">
						ausente
					</span>
				)}
				{finding.github &&
					(finding.github.url ? (
						<a
							class="sent-tag"
							href={finding.github.url}
							target="_blank"
							rel="noreferrer"
							title="Comentário enviado à PR"
						>
							<ExternalLink size={12} /> enviado
						</a>
					) : (
						<span class="sent-tag" title="Comentário enviado à PR">
							<ExternalLink size={12} /> enviado
						</span>
					))}
				<span class="spacer" />
				<button
					type="button"
					class={`done-btn${isDone ? " is-done" : ""}`}
					disabled={busy}
					title={isDone ? "Reabrir este finding" : "Marcar como feito"}
					onClick={() => void patch({ execState: isDone ? "pending" : "done" })}
				>
					{isDone ? (
						<>
							<Check size={14} /> Feito
						</>
					) : (
						"Marcar como feito"
					)}
				</button>
			</div>

			<h3 class="card-title">
				{open ? finding.message : truncateText(finding.message, 225)}
			</h3>

			{open && (
				<div class="card-body">
					<div class="meta-row">{finding.rule}</div>

					<div class="action-block">
						<Sparkles size={16} class="action-icon" />
						<div class="action-text">
							<span class="action-label">Ação:</span>
							<MarkdownText text={finding.action} />
						</div>
					</div>

					{finding.evidence &&
						(highlighted ? (
							<div class="evidence-block">
								<div class="evidence-head">
									<span class="code-lang">{highlighted.label}</span>
								</div>
								<pre class="evidence code-evidence">
									{highlighted.tokens.map((token) => (
										<span
											class={
												token.type === "plain"
													? undefined
													: `tok-${token.type}`
											}
										>
											{token.text}
										</span>
									))}
								</pre>
							</div>
						) : (
							<pre class="evidence">{finding.evidence}</pre>
						))}

					<div class="decision-tags-block">
						<div class="decisions">
							{DECISIONS.map((decision) => (
								<button
									type="button"
									title={`Marcar como ${DECISION_LABELS[decision]}`}
									class={`dec-btn dec-${decision}${
										finding.decision === decision ? " active" : ""
									}`}
									disabled={busy}
									onClick={() => void patch({ decision })}
								>
									{DECISION_LABELS[decision]}
								</button>
							))}
						</div>

						<span class="meta">
							<span class="meta-k">exec</span>
							<code>{finding.execState}</code>
						</span>

						<div class="tags">
							<span class="tags-label">
								<Watch size={13} /> Watchdogs
							</span>
							{(finding.watchdogIds.length > 0
								? finding.watchdogIds
								: ["—"]
							).map((id) => (
								<span class="tag" key={id}>
									{id}
								</span>
							))}
						</div>
					</div>

					<div class="comment">
						<textarea
							title="Comentário ou instrução adicional para o auto-fix"
							placeholder="Comentário / instrução para o auto-fix — salvo automaticamente"
							value={comment}
							onInput={(event) =>
								setComment((event.target as HTMLTextAreaElement).value)
							}
						/>
						{saveState === "saving" && (
							<span class="comment-status">
								<Spinner size={12} class="icon spin" /> Salvando…
							</span>
						)}
						{saveState === "saved" && (
							<span class="comment-status saved">
								<Check size={12} /> Salvo
							</span>
						)}
					</div>
				</div>
			)}
		</article>
	);
}

function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
