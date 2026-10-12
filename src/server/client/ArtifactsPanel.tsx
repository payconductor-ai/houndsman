/**
 * Painel de artefatos: abas para ver o conteúdo bruto dos arquivos da run.
 */

import { useEffect, useState } from "preact/hooks";
import { ARTIFACT_INFO, ARTIFACTS, type ArtifactName } from "./constants";

export function ArtifactsPanel({ slug }: { slug: string }) {
	const [name, setName] = useState<ArtifactName>(ARTIFACTS[0]);
	const [content, setContent] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		setError("");
		fetch(`/api/runs/${slug}/artifacts/${name}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				setContent(await res.text());
			})
			.catch((err) => {
				setContent("");
				setError(String(err));
			});
	}, [slug, name]);

	return (
		<div class="artifacts">
			<div class="tabs">
				{ARTIFACTS.map((artifact) => (
					<button
						type="button"
						title={ARTIFACT_INFO[artifact]}
						class={`btn tab${artifact === name ? " active" : ""}`}
						onClick={() => setName(artifact)}
					>
						{artifact}
					</button>
				))}
			</div>
			<p class="artifact-desc">{ARTIFACT_INFO[name]}</p>
			{error ? (
				<p class="error">{error}</p>
			) : (
				<pre class="artifact-view">{content}</pre>
			)}
		</div>
	);
}
