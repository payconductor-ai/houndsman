/**
 * Diff (domínio) — patch por arquivo + churn, com consultas coesas.
 *
 * Envolve o `DiffSource` coletado uma única vez pelo motor; não executa git.
 */

import type { DiffSource } from "../diff-source";
import type { FileChurn } from "../types";

/** Diff coletado de um intervalo de commits. */
export class Diff {
	private readonly source: DiffSource;

	constructor(source: DiffSource) {
		this.source = source;
	}

	/** Diff vazio (sem patch nem churn). */
	static empty(): Diff {
		return new Diff({ byFile: new Map(), churn: new Map() });
	}

	/** Todos os caminhos presentes no patch ou no churn. */
	get paths(): string[] {
		return [...new Set([...this.source.byFile.keys(), ...this.source.churn.keys()])];
	}

	/** Patch (header + hunks) de um arquivo, se houver. */
	patchFor(path: string): string | undefined {
		return this.source.byFile.get(path);
	}

	/** Churn de um arquivo; zero quando ausente. */
	churnOf(path: string): FileChurn {
		return this.source.churn.get(path) ?? { additions: 0, deletions: 0 };
	}

	/** Totais de churn do diff. */
	get totals(): { additions: number; deletions: number } {
		let additions = 0;
		let deletions = 0;
		for (const entry of this.source.churn.values()) {
			additions += entry.additions;
			deletions += entry.deletions;
		}
		return { additions, deletions };
	}

	/** `DiffSource` subjacente (para as funções puras que ainda o recebem). */
	toSource(): DiffSource {
		return this.source;
	}
}
