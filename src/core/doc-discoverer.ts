/**
 * Descobre documentação relevante para um conjunto de arquivos alterados
 * (biblioteca). Entrypoint: `cli/review.ts`.
 *
 * Os mapeamentos (`docMappings`) e os docs sempre incluídos vivem no projeto
 * (`project/doc-mappings.ts`) e chegam via `HoundsmanConfig`.
 */

import { DEFAULT_ALWAYS_INCLUDE_DOCS, type HoundsmanConfig } from "./config";

/** Descobre docs relevantes com base nos paths + docs sempre incluídos. */
export function discoverDocs(filePaths: string[], config: HoundsmanConfig): string[] {
	const docs = new Set<string>();

	for (const doc of config.alwaysIncludeDocs ?? DEFAULT_ALWAYS_INCLUDE_DOCS) {
		docs.add(doc);
	}

	for (const filePath of filePaths) {
		const normalized = filePath.trim().toLowerCase();
		if (!normalized) continue;

		for (const [pattern, docPaths] of config.docMappings) {
			if (pattern.test(normalized)) {
				for (const docPath of docPaths) {
					docs.add(docPath);
				}
			}
		}
	}

	return [...docs].sort();
}
