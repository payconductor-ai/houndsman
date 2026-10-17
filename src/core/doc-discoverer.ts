/**
 * Descobre documentação relevante para um conjunto de arquivos alterados
 * (biblioteca). Entrypoint: `cli/review.ts`.
 *
 * Os mapeamentos (`docMappings`) e os docs sempre incluídos vivem no projeto
 * (`project/doc-mappings.ts`) e chegam via `HoundsmanConfig`.
 */

import type { HoundsmanConfig } from "./config";
import { ProjectConfig } from "./project-config";

/** Descobre documentação relevante para um conjunto de arquivos alterados. */
export class DocDiscoverer {
	private readonly alwaysInclude: readonly string[];
	private readonly mappings: readonly (readonly [RegExp, readonly string[]])[];

	constructor(config: HoundsmanConfig) {
		const project = new ProjectConfig(config);
		this.alwaysInclude = project.alwaysIncludeDocs;
		this.mappings = project.docMappings;
	}

	discover(filePaths: readonly string[]): string[] {
		const docs = new Set<string>(this.alwaysInclude);

		for (const filePath of filePaths) {
			const normalized = filePath.trim().toLowerCase();
			if (!normalized) continue;

			for (const [pattern, docPaths] of this.mappings) {
				if (!pattern.test(normalized)) continue;
				for (const docPath of docPaths) docs.add(docPath);
			}
		}

		return [...docs].sort();
	}
}

/** Descobre docs relevantes com base nos paths + docs sempre incluídos. */
export function discoverDocs(filePaths: string[], config: HoundsmanConfig): string[] {
	return new DocDiscoverer(config).discover(filePaths);
}
