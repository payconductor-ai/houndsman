/**
 * Painel de artefatos: lista todos os artefatos persistidos da run e renderiza
 * o conteúdo bruto. JSON ganha destaque de sintaxe; markdown é renderizado com
 * o mesmo parser/highlight do restante da UI. Briefs e relatórios ficam
 * auditáveis pela mesma navegação.
 */

import { useEffect, useMemo, useState } from "preact/hooks";
import { MarkdownText } from "./MarkdownText";
import { api } from "./utils/api";
import {
	ARTIFACT_KIND_LABELS,
	describeArtifact,
	displayArtifactName,
	groupArtifacts,
	isJsonArtifact,
	isMarkdownArtifact,
} from "./utils/constants";
import { formatJson, highlightJson } from "./utils/json-highlight";
import type { ArtifactMeta } from "./utils/types";

/** Prefere o resumo final; senão, o primeiro artefato disponível. */
function pickDefault(items: ArtifactMeta[]): string {
	return (
		(items.find((item) => item.name === "review-resume.md") ?? items[0])?.name ?? ""
	);
}

/** JSON com destaque de sintaxe (tokens em spans, sem lib externa). */
function JsonView({ content }: { content: string }) {
	const tokens = useMemo(() => highlightJson(formatJson(content)), [content]);
	return (
		<pre class="artifact-view json-view">
			{tokens.map((token) => (
				<span class={token.type === "plain" ? undefined : `json-${token.type}`}>
					{token.text}
				</span>
			))}
		</pre>
	);
}

export function ArtifactsPanel({ slug }: { slug: string }) {
	const [items, setItems] = useState<ArtifactMeta[]>([]);
	const [name, setName] = useState("");
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setError("");
		api<{ artifacts: ArtifactMeta[] }>(`/api/runs/${slug}/artifacts`)
			.then(({ artifacts }) => {
				if (cancelled) return;
				setItems(artifacts);
				setName((current) =>
					artifacts.some((item) => item.name === current)
						? current
						: pickDefault(artifacts),
				);
			})
			.catch((err) => {
				if (cancelled) return;
				setItems([]);
				setName("");
				setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [slug]);

	useEffect(() => {
		if (!name) {
			setContent("");
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError("");
		fetch(`/api/runs/${slug}/artifacts/${encodeURI(name)}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const text = await res.text();
				if (!cancelled) setContent(text);
			})
			.catch((err) => {
				if (cancelled) return;
				setContent("");
				setError(String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [slug, name]);

	const groups = useMemo(() => groupArtifacts(items), [items]);
	const selected = useMemo(
		() => items.find((item) => item.name === name),
		[items, name],
	);

	return (
		<div class="artifacts">
			<div class="artifact-layout">
				<nav class="artifact-list" aria-label="Artefatos da revisão">
					{groups.map((group) => (
						<div class="artifact-group" key={group.key}>
							<p class="artifact-group-label">{group.label}</p>
							{group.items.map((item) => (
								<button
									type="button"
									key={item.name}
									title={item.name}
									class={`artifact-item${item.name === name ? " active" : ""}`}
									onClick={() => setName(item.name)}
								>
									<span class="artifact-item-name">
										{displayArtifactName(item)}
									</span>
									<span class="artifact-item-kind">
										{ARTIFACT_KIND_LABELS[item.kind] ?? item.kind}
									</span>
								</button>
							))}
						</div>
					))}
					{items.length === 0 && !loading && (
						<p class="empty">Nenhum artefato persistido nesta run.</p>
					)}
				</nav>

				<section class="artifact-pane">
					{selected ? (
						<header class="artifact-head">
							<div>
								<h3 class="artifact-title">{selected.name}</h3>
								<p class="artifact-desc">{describeArtifact(selected)}</p>
							</div>
							<span class="artifact-kind-badge">
								{ARTIFACT_KIND_LABELS[selected.kind] ?? selected.kind}
							</span>
						</header>
					) : null}

					{error ? (
						<p class="error">{error}</p>
					) : loading ? (
						<p class="empty">Carregando artefato…</p>
					) : selected ? (
						isJsonArtifact(selected) ? (
							<JsonView content={content} />
						) : isMarkdownArtifact(selected) ? (
							<div class="artifact-view artifact-markdown">
								<MarkdownText text={content} />
							</div>
						) : (
							<pre class="artifact-view">{content || "—"}</pre>
						)
					) : (
						<p class="empty">Selecione um artefato para visualizar.</p>
					)}
				</section>
			</div>
		</div>
	);
}
