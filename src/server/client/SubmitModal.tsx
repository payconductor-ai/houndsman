/**
 * Modal "Enviar revisão": publica os findings selecionados como comentários na
 * Pull Request (`POST /submit`, via `gh`).
 *
 * Filtra por severidade e estado de execução, mostra uma prévia curta do que
 * será disparado e o resultado (com o link do comentário geral, quando houver).
 * Fail-open: sem `gh`/PR o servidor devolve `available:false` e o modal só
 * informa — nada é postado.
 */

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "./api";
import { EXEC_STATES, SEVERITY_LABELS, SEVERITY_ORDER } from "./constants";
import { ExternalLink, Send, Spinner } from "./icons";
import type {
	ExecState,
	Severity,
	SubmitOutcome,
	SubmitPreview,
	SubmitResponse,
} from "./types";

const EXEC_LABELS: Record<ExecState, string> = {
	pending: "Pendente",
	in_progress: "Em andamento",
	done: "Feito",
	stale: "Stale",
};

export function SubmitModal({
	slug,
	branch,
	open,
	onClose,
	onSubmitted,
}: {
	slug: string;
	branch: string;
	open: boolean;
	onClose: () => void;
	onSubmitted: () => void;
}) {
	const [preview, setPreview] = useState<SubmitPreview | null>(null);
	const [severities, setSeverities] = useState<Severity[]>([]);
	const [execStates, setExecStates] = useState<ExecState[]>([]);
	const [includeSent, setIncludeSent] = useState(false);
	const [loading, setLoading] = useState(false);
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<SubmitOutcome | null>(null);

	// Carrega a prévia ao abrir (os filtros são aplicados no cliente).
	useEffect(() => {
		if (!open) return;
		let alive = true;
		setLoading(true);
		setError("");
		setResult(null);
		api<SubmitPreview>(`/api/runs/${slug}/submit-preview`)
			.then((data) => {
				if (alive) setPreview(data);
			})
			.catch((err) => {
				if (alive) setError(String(err));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [open, slug]);

	// Esc fecha o modal.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const toggleSeverity = (value: Severity) =>
		setSeverities((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	const toggleExec = (value: ExecState) =>
		setExecStates((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);

	const selected = useMemo(
		() =>
			(preview?.candidates ?? []).filter(
				(candidate) =>
					(severities.length === 0 ||
						severities.includes(candidate.severity)) &&
					(execStates.length === 0 || execStates.includes(candidate.execState)),
			),
		[preview, severities, execStates],
	);

	const toSend = useMemo(
		() => selected.filter((candidate) => includeSent || !candidate.sent),
		[selected, includeSent],
	);
	const inline = toSend.filter((candidate) => candidate.inline).length;
	const body = toSend.length - inline;
	const skipped = selected.length - toSend.length;

	const submit = useCallback(async () => {
		setPosting(true);
		setError("");
		try {
			const res = await api<SubmitResponse>(`/api/runs/${slug}/submit`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					severities: severities.length > 0 ? severities : undefined,
					execStates: execStates.length > 0 ? execStates : undefined,
					includeSent,
				}),
			});
			if (!res.available) {
				setError(res.reason ?? "PR indisponível para envio.");
				return;
			}
			setResult(res.outcome ?? null);
			onSubmitted();
		} catch (err) {
			setError(String(err));
		} finally {
			setPosting(false);
		}
	}, [slug, severities, execStates, includeSent, onSubmitted]);

	if (!open) return null;

	return (
		<div class="modal-layer">
			<button
				type="button"
				class="modal-backdrop"
				aria-label="Fechar"
				title="Fechar"
				onClick={onClose}
			/>
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Enviar revisão"
			>
				<header class="modal-head">
					<div>
						<h2 class="modal-title">Enviar revisão</h2>
						<p class="modal-sub">
							Publica os findings selecionados como comentários na PR
							{branch ? ` de ${branch}` : ""} (via gh).
						</p>
					</div>
					<button
						type="button"
						class="modal-close"
						title="Fechar"
						onClick={onClose}
					>
						×
					</button>
				</header>

				<div class="modal-body">
					{loading && (
						<p class="submit-empty">
							<Spinner size={14} class="icon spin" /> Carregando prévia…
						</p>
					)}
					{error && <p class="error">{error}</p>}

					{result ? (
						<ResultView outcome={result} />
					) : (
						preview && (
							<>
								{!preview.available && (
									<p class="submit-empty">
										PR indisponível: {preview.reason}. A triagem
										segue; o envio fica para quando houver PR + gh.
									</p>
								)}

								<div class="submit-field">
									<span class="submit-label">Severidade</span>
									<div class="chips">
										<button
											type="button"
											class={`chip${severities.length === 0 ? " active" : ""}`}
											onClick={() => setSeverities([])}
										>
											Todas
										</button>
										{SEVERITY_ORDER.map((severity) => (
											<button
												type="button"
												key={severity}
												class={`chip sev-${severity}${
													severities.includes(severity)
														? " active"
														: ""
												}`}
												onClick={() => toggleSeverity(severity)}
											>
												{SEVERITY_LABELS[severity]}
											</button>
										))}
									</div>
								</div>

								<div class="submit-field">
									<span class="submit-label">Execução</span>
									<div class="chips">
										<button
											type="button"
											class={`chip${execStates.length === 0 ? " active" : ""}`}
											onClick={() => setExecStates([])}
										>
											Todos
										</button>
										{EXEC_STATES.map((state) => (
											<button
												type="button"
												key={state}
												class={`chip${
													execStates.includes(state)
														? " active"
														: ""
												}`}
												onClick={() => toggleExec(state)}
											>
												{EXEC_LABELS[state]}
											</button>
										))}
									</div>
								</div>

								<label class="submit-check">
									<input
										type="checkbox"
										checked={includeSent}
										onChange={(event) =>
											setIncludeSent(
												(event.target as HTMLInputElement)
													.checked,
											)
										}
									/>
									Reenviar os já enviados
								</label>

								<div class="submit-summary">
									Serão disparados <b>{toSend.length}</b> comentário(s)
									— <b>{inline}</b> inline · <b>{body}</b> no corpo
									{skipped > 0 ? (
										<>
											{" "}
											· <b>{skipped}</b> já enviado(s) pulado(s)
										</>
									) : null}
									.
								</div>

								<div class="submit-field">
									<span class="submit-label">
										Prévia ({toSend.length})
									</span>
									{toSend.length === 0 ? (
										<p class="submit-empty">
											Nada a enviar com os filtros atuais.
										</p>
									) : (
										<div class="submit-list">
											{toSend.map((candidate) => (
												<div
													class={`submit-item${candidate.sent ? " sent" : ""}`}
													key={candidate.id}
												>
													<span
														class={`sev-badge sev-${candidate.severity}`}
													>
														{
															SEVERITY_LABELS[
																candidate.severity
															]
														}
													</span>
													<code class="loc static">
														{candidate.line
															? `${candidate.file}:${candidate.line}`
															: candidate.file}
													</code>
													<span class="rule">
														{candidate.rule}
													</span>
													{!candidate.inline && (
														<span
															class="tag"
															title="Sem linha no diff — vai no comentário geral"
														>
															corpo
														</span>
													)}
												</div>
											))}
										</div>
									)}
								</div>
							</>
						)
					)}
				</div>

				<footer class="modal-foot">
					<span class="submit-label">
						{preview?.available && preview.target
							? `PR #${preview.target.number} · ${preview.target.repo}`
							: "sem PR"}
					</span>
					{result ? (
						<button type="button" class="btn" onClick={onClose}>
							Fechar
						</button>
					) : (
						<div class="submit-actions">
							<button
								type="button"
								class="btn"
								disabled={posting}
								onClick={onClose}
							>
								Cancelar
							</button>
							<button
								type="button"
								class="btn submit-review"
								disabled={
									posting || !preview?.available || toSend.length === 0
								}
								onClick={() => void submit()}
							>
								{posting ? (
									<Spinner size={15} class="icon spin" />
								) : (
									<Send size={15} />
								)}
								{posting ? "Enviando…" : `Enviar (${toSend.length})`}
							</button>
						</div>
					)}
				</footer>
			</div>
		</div>
	);
}

/** Resumo do resultado do envio. */
function ResultView({ outcome }: { outcome: SubmitOutcome }) {
	const generalUrl = outcome.general?.url;
	return (
		<>
			<div class="submit-summary">
				Enviados <b>{outcome.posted.length}</b> · falhas{" "}
				<b>{outcome.failed.length}</b> · pulados <b>{outcome.skipped.length}</b>.
			</div>
			{generalUrl && (
				<p class="submit-empty">
					Comentário geral:{" "}
					<a
						class="sent-tag"
						href={generalUrl}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink size={12} /> abrir
					</a>
				</p>
			)}
			{outcome.failed.length > 0 && (
				<div class="submit-list">
					{outcome.failed.map((failure) => (
						<div class="submit-item" key={failure.id}>
							<code class="loc static">{failure.id}</code>
							<span class="rule">{failure.reason}</span>
						</div>
					))}
				</div>
			)}
		</>
	);
}
