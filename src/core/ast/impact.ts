/**
 * Impacto estrutural (biblioteca).
 *
 * Resolve imports relativos/aliases e monta o mapa reverso (quem importa os
 * arquivos alterados) e os exports públicos que mudaram. O serviço decide como
 * descobrir candidatos; aqui ficam apenas as funções puras.
 */

import { posix } from "node:path";
import type { AstAnalysis, AstImpact } from "./types";

/** Testa se um caminho existe (working tree ou índice do git). */
export type PathExists = (path: string) => boolean;

/** Extensões tentadas ao resolver um import sem extensão. */
const CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/** Índices de diretório tentados. */
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/** Remove query/hash de um specifier. */
function stripQuery(source: string): string {
	const index = source.search(/[?#]/);
	return index >= 0 ? source.slice(0, index) : source;
}

/** Remove a extensão de runtime usada em imports ESM (`./x.js` → `./x`). */
function stripRuntimeExtension(source: string): string {
	return source.replace(/\.(?:js|jsx|mjs|cjs)$/i, "");
}

/** Normaliza uma chave de alias (`@/*` / `@/` → `@/`). */
function normalizeAliasKey(key: string): string {
	const withoutWildcard = key.endsWith("*") ? key.slice(0, -1) : key;
	return withoutWildcard.endsWith("/") ? withoutWildcard : `${withoutWildcard}/`;
}

/** Normaliza o alvo do alias (`src/*` → `src/`). */
function normalizeAliasTarget(target: string): string {
	const withoutWildcard = target.endsWith("*") ? target.slice(0, -1) : target;
	return withoutWildcard.replace(/\/+$/, "");
}

/**
 * Resolve um specifier para um caminho relativo à raiz do repo.
 * `null` quando é pacote externo, alias desconhecido ou candidato inexistente.
 */
export function resolveImport(
	fromFile: string,
	source: string,
	aliases: Record<string, string>,
	exists: PathExists,
): string | null {
	const clean = stripRuntimeExtension(stripQuery(source.trim()));
	if (!clean) return null;

	let base: string | null = null;
	if (clean.startsWith(".")) {
		base = posix.normalize(posix.join(posix.dirname(fromFile), clean));
	} else {
		for (const [rawKey, rawTarget] of Object.entries(aliases)) {
			const key = normalizeAliasKey(rawKey);
			if (!clean.startsWith(key)) continue;
			const target = normalizeAliasTarget(rawTarget);
			const rest = clean.slice(key.length);
			base = posix.normalize(posix.join(target, rest));
			break;
		}
	}
	if (!base) return null;

	const candidates = [base];
	for (const extension of CANDIDATE_EXTENSIONS) candidates.push(`${base}${extension}`);
	for (const index of INDEX_FILES) candidates.push(posix.join(base, index));

	for (const candidate of candidates) {
		const normalized = candidate.replace(/^\.\//, "");
		if (exists(normalized)) return normalized;
	}
	return null;
}

/**
 * Monta o impacto a partir das análises dos arquivos alterados e do mapa de
 * importadores descoberto pelo serviço (`arquivo alterado → importadores`).
 */
export function buildImpact(
	analyses: ReadonlyMap<string, AstAnalysis>,
	importersByFile: ReadonlyMap<string, ReadonlySet<string>>,
): AstImpact {
	const importers: Record<string, string[]> = {};
	const affected = new Set<string>();
	const exportedChanges: AstImpact["exportedChanges"] = [];

	for (const [file, files] of importersByFile) {
		const sorted = [...files].sort();
		if (sorted.length === 0) continue;
		importers[file] = sorted;
		for (const importer of sorted) affected.add(importer);
	}

	for (const [file, analysis] of analyses) {
		const delta = analysis.delta;
		if (!delta) continue;
		for (const symbol of delta.removedSymbols) {
			if (!symbol.exported) continue;
			exportedChanges.push({ file, symbol: symbol.name, change: "removed" });
		}
		for (const change of delta.changedSignatures) {
			if (!change.exported) continue;
			exportedChanges.push({ file, symbol: change.name, change: "signature" });
		}
	}

	exportedChanges.sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			a.symbol.localeCompare(b.symbol) ||
			a.change.localeCompare(b.change),
	);

	return {
		importers,
		affectedFiles: [...affected].sort(),
		exportedChanges,
	};
}
