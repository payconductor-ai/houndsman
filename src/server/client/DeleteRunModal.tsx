/**
 * Modal "Excluir execução": confirma a remoção definitiva da run.
 *
 * Apaga a review, findings, histórico de triagem, artefatos e o staging local.
 * Quando a run tem worktree, oferece removê-lo junto (alterações não commitadas
 * nele são descartadas).
 */

import { useEffect, useState } from "preact/hooks";
import { Spinner, Trash } from "./icons";
import { api } from "./utils/api";
import type { DeleteRunResponse } from "./utils/types";

export function DeleteRunModal({
	slug,
	branch,
	worktreePath,
	open,
	onClose,
	onDeleted,
}: {
	slug: string;
	branch: string;
	worktreePath?: string;
	open: boolean;
	onClose: () => void;
	onDeleted: (result: DeleteRunResponse) => void;
}) {
	const [removeWorktree, setRemoveWorktree] = useState(Boolean(worktreePath));
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) return;
		setRemoveWorktree(Boolean(worktreePath));
		setDeleting(false);
		setError("");
	}, [open, worktreePath]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !deleting) onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, deleting, onClose]);

	if (!open) return null;

	const confirm = async () => {
		setDeleting(true);
		setError("");
		try {
			const suffix = removeWorktree && worktreePath ? "?worktree=1" : "";
			const result = await api<DeleteRunResponse>(`/api/runs/${slug}${suffix}`, {
				method: "DELETE",
			});
			if (!result.deleted) throw new Error("A execução não foi encontrada.");
			onDeleted(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div class="modal-layer">
			<button
				type="button"
				class="modal-backdrop"
				aria-label="Fechar"
				title="Fechar"
				onClick={() => {
					if (!deleting) onClose();
				}}
			/>
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Excluir execução"
			>
				<header class="modal-head">
					<div>
						<h2 class="modal-title">Excluir execução</h2>
						<p class="modal-sub">
							Esta ação é permanente e apaga a revisão de{" "}
							<code>{branch}</code>.
						</p>
					</div>
					<button
						type="button"
						class="modal-close"
						title="Fechar"
						disabled={deleting}
						onClick={onClose}
					>
						×
					</button>
				</header>

				<div class="modal-body">
					<p class="modal-warn">
						Serão removidos os findings, o histórico de triagem, todos os
						artefatos (briefs, classificação, manifesto, relatório, verify) e
						o staging local desta run. O envio já feito ao GitHub não é
						desfeito.
					</p>

					{worktreePath && (
						<label class="modal-check">
							<input
								type="checkbox"
								checked={removeWorktree}
								disabled={deleting}
								onChange={(event) =>
									setRemoveWorktree(event.currentTarget.checked)
								}
							/>
							<span>
								Excluir também o worktree desta execução. Alterações não
								commitadas nele serão perdidas.
								<br />
								<code>{worktreePath}</code>
							</span>
						</label>
					)}

					{error && <p class="error">{error}</p>}
				</div>

				<footer class="modal-foot">
					<span class="submit-label">Run: {branch}</span>
					<div class="submit-actions">
						<button
							type="button"
							class="btn"
							disabled={deleting}
							onClick={onClose}
						>
							Cancelar
						</button>
						<button
							type="button"
							class="btn danger"
							disabled={deleting}
							onClick={() => void confirm()}
						>
							{deleting ? (
								<Spinner size={15} class="icon spin" />
							) : (
								<Trash size={15} />
							)}
							{deleting ? "Excluindo…" : "Excluir execução"}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
