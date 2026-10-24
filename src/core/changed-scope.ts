/**
 * Escopo do diff (engine) — o que esta revisão realmente alterou.
 *
 * Traduz os hunks do diff (`-U0`) em faixas de linhas revisáveis por arquivo e,
 * quando o AST está disponível, no menor símbolo folha que contém cada âncora.
 * É a fonte única usada pelo brief e pela pré-análise para evitar
 * achados em código pré-existente.
 *
 * Fail-open: sem AST (grammar ausente/`--no-ast`/binário) o escopo cai nos
 * hunks; sem patch, o arquivo fica sem faixas.
 */

import { changedAnchors } from "./ast/diff";
import type { AstAnalysis, AstSymbol, AstSymbolKind } from "./ast/types";
import type { DiffSource } from "./diff-source";

/** Intervalo de linhas (1-based, inclusivo). */
export type LineRange = { start: number; end: number };

/** Símbolo alterado (o menor símbolo folha que contém uma âncora). */
export type ChangedSymbol = {
	name: string;
	kind: AstSymbolKind;
	startLine: number;
	endLine: number;
};

/** Origem do escopo: AST (símbolos) ou hunks (fallback determinístico). */
export type ChangedScopeSource = "ast" | "hunks";

/** Escopo de um arquivo alterado. */
export type FileChangedScope = {
	/** Faixas revisáveis (símbolos alterados + âncoras soltas), ordenadas. */
	ranges: LineRange[];
	/** Símbolos folha tocados pelas âncoras. */
	symbols: ChangedSymbol[];
	source: ChangedScopeSource;
};

/** Escopo do diff: caminho do arquivo → faixas revisáveis. */
export type ChangedScope = Record<string, FileChangedScope>;

/** Entrada mínima do builder (status do `git diff --name-status`). */
export type ScopeEntry = { path: string; status: string };

export type BuildChangedScopeInput = {
	entries: readonly ScopeEntry[];
	/** Patch por arquivo (idealmente `git diff -U0`, sem truncar). */
	diff: DiffSource;
	/** Análises da versão atual (`null`/ausente → fallback nos hunks). */
	ast?: ReadonlyMap<string, AstAnalysis>;
};

/** Espécies que representam containers: não expandem sozinhas o escopo. */
const CONTAINER_KINDS: ReadonlySet<AstSymbolKind> = new Set([
	"class",
	"interface",
	"enum",
]);

/** Tamanho do intervalo de um símbolo (menor = mais específico). */
function span(symbol: AstSymbol): number {
	return symbol.endLine - symbol.startLine;
}

/** Menor símbolo folha que contém a linha (containers são ignorados). */
function leafAt(symbols: readonly AstSymbol[], line: number): AstSymbol | undefined {
	let best: AstSymbol | undefined;
	for (const symbol of symbols) {
		if (CONTAINER_KINDS.has(symbol.kind)) continue;
		if (line < symbol.startLine || line > symbol.endLine) continue;
		if (!best || span(symbol) < span(best)) best = symbol;
	}
	return best;
}

/** Converte um símbolo AST no shape do escopo. */
function toChangedSymbol(symbol: AstSymbol): ChangedSymbol {
	return {
		name: symbol.name,
		kind: symbol.kind,
		startLine: symbol.startLine,
		endLine: symbol.endLine,
	};
}

/** Deduplica símbolos por identidade e posição, mantendo a ordem de leitura. */
function uniqueSymbols(symbols: readonly AstSymbol[]): ChangedSymbol[] {
	const seen = new Set<string>();
	const result: ChangedSymbol[] = [];
	for (const symbol of symbols) {
		const key = `${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(toChangedSymbol(symbol));
	}
	return result.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/** `true` se a linha está dentro de alguma faixa. */
export function isLineInScope(scope: ChangedScope, file: string, line: number): boolean {
	const entry = scope[file];
	if (!entry) return false;
	return entry.ranges.some((range) => line >= range.start && line <= range.end);
}

/** Une intervalos sobrepostos/adjacentes (ordem estável por início). */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges]
		.filter((range) => range.end >= range.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const last = merged.at(-1);
		if (last && range.start <= last.end + 1) {
			last.end = Math.max(last.end, range.end);
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

/**
 * Escopo por arquivo alterado. Arquivos deletados/renomeados sem hunks ficam
 * com faixas vazias (não há código atual para ancorar finding).
 */
export function buildChangedScope(input: BuildChangedScopeInput): ChangedScope {
	const scope: ChangedScope = {};

	for (const entry of input.entries) {
		if (entry.status === "deleted") continue;
		const analysis = input.ast?.get(entry.path);
		if (analysis?.deleted) continue;

		const patch = input.diff.byFile.get(entry.path) ?? "";
		const { added, deletedAt } = changedAnchors(patch);
		const anchors = new Set<number>([...added, ...deletedAt]);
		const source: ChangedScopeSource = analysis ? "ast" : "hunks";

		const touched: AstSymbol[] = [];
		if (analysis) {
			for (const line of anchors) {
				const symbol = leafAt(analysis.facts.symbols, line);
				if (symbol) touched.push(symbol);
			}
		}
		const symbols = uniqueSymbols(touched);

		// Âncoras fora de símbolo folha (imports, topo do módulo, cabeçalho de
		// classe) continuam revisáveis como faixas avulsas.
		const covered = (line: number): boolean =>
			symbols.some((symbol) => line >= symbol.startLine && line <= symbol.endLine);
		const loose = [...anchors].filter((line) => !covered(line));

		scope[entry.path] = {
			ranges: mergeRanges([
				...symbols.map((symbol) => ({
					start: symbol.startLine,
					end: symbol.endLine,
				})),
				...loose.map((line) => ({ start: line, end: line })),
			]),
			symbols,
			source,
		};
	}

	return scope;
}

/** Totais do escopo (mensagens, tool e testes). */
export function summarizeScope(scope: ChangedScope): {
	files: number;
	ranges: number;
	symbols: number;
} {
	let ranges = 0;
	let symbols = 0;
	for (const entry of Object.values(scope)) {
		ranges += entry.ranges.length;
		symbols += entry.symbols.length;
	}
	return { files: Object.keys(scope).length, ranges, symbols };
}

/** Faixas em texto compacto (`10-14, 22`) para prompts e briefs. */
export function formatRanges(ranges: readonly LineRange[], max = 8): string {
	if (ranges.length === 0) return "sem linhas alteradas";
	const shown = ranges
		.slice(0, max)
		.map((range) =>
			range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`,
		);
	const rest = ranges.length > max ? ` (+${ranges.length - max})` : "";
	return `${shown.join(", ")}${rest}`;
}

/** Símbolos em texto compacto (`` `foo` (10-40)``) para prompts e briefs. */
export function formatSymbols(symbols: readonly ChangedSymbol[], max = 6): string {
	if (symbols.length === 0) return "";
	const shown = symbols
		.slice(0, max)
		.map((symbol) => `\`${symbol.name}\` (${symbol.startLine}-${symbol.endLine})`);
	const rest = symbols.length > max ? ` (+${symbols.length - max})` : "";
	return `${shown.join(", ")}${rest}`;
}
