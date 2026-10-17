/**
 * Delta estrutural entre duas versões de um arquivo (biblioteca).
 *
 * O patch unificado informa quais linhas novas mudaram; os símbolos da versão
 * atual com intervalo tocado viram `modifiedSymbols`. Símbolos que só existem
 * em um dos lados viram `added`/`removed`. Tudo é puro e determinístico.
 */

import type {
	AstDelta,
	AstExportChange,
	AstFacts,
	AstSignatureChange,
	AstSymbol,
} from "./types";

/** Um hunk do patch, com as linhas novas adicionadas. */
export type AstHunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Linhas novas (1-based) introduzidas pelo hunk. */
	addedLines: number[];
};

/** Regex do cabeçalho de hunk (`@@ -a,b +c,d @@`). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Converte um número opcional do header (default 1). */
function countOf(value: string | undefined): number {
	const parsed = value ? Number.parseInt(value, 10) : 1;
	return Number.isNaN(parsed) ? 1 : parsed;
}

/** Fatia um patch unificado por arquivo em hunks. */
export function parseHunks(patch: string): AstHunk[] {
	const hunks: AstHunk[] = [];
	let current: AstHunk | null = null;
	let newLine = 0;

	for (const line of patch.split("\n")) {
		if (line.startsWith("@@ ")) {
			const match = HUNK_HEADER.exec(line);
			if (!match) {
				current = null;
				continue;
			}
			current = {
				oldStart: Number.parseInt(match[1], 10),
				oldLines: countOf(match[2]),
				newStart: Number.parseInt(match[3], 10),
				newLines: countOf(match[4]),
				addedLines: [],
			};
			newLine = current.newStart;
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("diff --git ")) {
			current = null;
			continue;
		}
		if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		if (line.startsWith("+")) {
			current.addedLines.push(newLine);
			newLine++;
			continue;
		}
		if (line.startsWith("-")) continue;
		if (line.startsWith("\\")) continue;
		if (line.startsWith(" ")) newLine++;
	}

	return hunks;
}

/** Conjunto de linhas novas (1-based) adicionadas pelo patch. */
export function changedNewLines(patch: string): Set<number> {
	const lines = new Set<number>();
	for (const hunk of parseHunks(patch)) {
		for (const line of hunk.addedLines) lines.add(line);
	}
	return lines;
}

/** Chave estável de um símbolo (espécie + nome). */
function symbolKey(symbol: AstSymbol): string {
	return `${symbol.kind}:${symbol.name}`;
}

/** Indexa símbolos por chave. */
function indexSymbols(symbols: readonly AstSymbol[]): Map<string, AstSymbol> {
	const map = new Map<string, AstSymbol>();
	for (const symbol of symbols) map.set(symbolKey(symbol), symbol);
	return map;
}

/** `true` se alguma linha alterada cai no intervalo do símbolo. */
function touches(symbol: AstSymbol, changed: ReadonlySet<number>): boolean {
	for (const line of changed) {
		if (line >= symbol.startLine && line <= symbol.endLine) return true;
	}
	return false;
}

/** Fonte dos imports (deduplicada e ordenada). */
function importSources(facts: AstFacts | null): Set<string> {
	return new Set((facts?.imports ?? []).map((item) => item.source));
}

/** Nomes dos exports (deduplicados e ordenados). */
function exportNames(facts: AstFacts | null): Set<string> {
	return new Set((facts?.exports ?? []).map((item) => item.name));
}

/** Compara dois conjuntos e devolve o que foi adicionado/removido. */
function setDelta(
	before: Set<string>,
	after: Set<string>,
): {
	added: string[];
	removed: string[];
} {
	const added = [...after].filter((item) => !before.has(item)).sort();
	const removed = [...before].filter((item) => !after.has(item)).sort();
	return { added, removed };
}

/** Delta vazio (arquivos sem alteração estrutural). */
export function emptyDelta(): AstDelta {
	return {
		addedSymbols: [],
		removedSymbols: [],
		modifiedSymbols: [],
		changedSignatures: [],
		addedImports: [],
		removedImports: [],
		changedExports: [],
	};
}

/**
 * Compara a versão base com a atual e o patch do arquivo.
 * `before`/`after` ausentes representam arquivo adicionado/deletado.
 */
export function computeDelta(
	before: AstFacts | null,
	after: AstFacts | null,
	patch: string,
): AstDelta {
	if (!before && !after) return emptyDelta();

	const changed = changedNewLines(patch);
	const beforeSymbols = indexSymbols(before?.symbols ?? []);
	const afterSymbols = indexSymbols(after?.symbols ?? []);
	const beforeExportNames = exportNames(before);
	const afterExportNames = exportNames(after);
	const withExport = (symbol: AstSymbol, names: ReadonlySet<string>): AstSymbol =>
		symbol.exported || names.has(symbol.name)
			? { ...symbol, exported: true }
			: symbol;

	const addedSymbols: AstSymbol[] = [];
	const removedSymbols: AstSymbol[] = [];
	const modifiedSymbols: AstSymbol[] = [];
	const changedSignatures: AstSignatureChange[] = [];

	for (const [key, symbol] of afterSymbols) {
		const previous = beforeSymbols.get(key);
		if (!previous) {
			addedSymbols.push(withExport(symbol, afterExportNames));
			continue;
		}
		if (touches(symbol, changed)) {
			modifiedSymbols.push(withExport(symbol, afterExportNames));
		}
		if (
			(previous.signature || symbol.signature) &&
			previous.signature !== symbol.signature
		) {
			changedSignatures.push({
				name: symbol.name,
				before: previous.signature ?? "",
				after: symbol.signature ?? "",
				exported:
					symbol.exported ||
					previous.exported ||
					beforeExportNames.has(symbol.name) ||
					afterExportNames.has(symbol.name),
			});
		}
	}
	for (const [key, symbol] of beforeSymbols) {
		if (!afterSymbols.has(key)) {
			removedSymbols.push(withExport(symbol, beforeExportNames));
		}
	}

	const imports = setDelta(importSources(before), importSources(after));
	const exports = setDelta(exportNames(before), exportNames(after));
	const changedExports: AstExportChange[] = [
		...exports.added.map((name) => ({ name, change: "added" as const })),
		...exports.removed.map((name) => ({ name, change: "removed" as const })),
	];

	const byPosition = (a: AstSymbol, b: AstSymbol): number =>
		a.startLine - b.startLine || a.name.localeCompare(b.name);

	return {
		addedSymbols: addedSymbols.sort(byPosition),
		removedSymbols: removedSymbols.sort(byPosition),
		modifiedSymbols: modifiedSymbols.sort(byPosition),
		changedSignatures: changedSignatures.sort((a, b) => a.name.localeCompare(b.name)),
		addedImports: imports.added,
		removedImports: imports.removed,
		changedExports,
	};
}
