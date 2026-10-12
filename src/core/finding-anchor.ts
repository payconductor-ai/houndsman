/**
 * Identidade e reancoragem de findings (biblioteca).
 *
 * Um finding NÃO é identificado pela linha: a linha desloca após um auto-fix.
 * A identidade é o `fingerprint` (arquivo + regra + âncora de conteúdo); a linha
 * é apenas cache, recalculada varrendo o arquivo (`locateAnchor`).
 *
 * Âncora = linha ofensora normalizada + contexto (linha anterior/seguinte).
 * Quando o fix altera a linha ofensora, a âncora some → o finding fica `stale`.
 *
 * Ocorrências byte-idênticas (mesmo snippet E mesmo contexto) compartilham o
 * fingerprint: são tratadas como um grupo (limitação conhecida).
 */

import { createHash } from "node:crypto";

/** Âncora de conteúdo de um finding (independente do número da linha). */
export type FindingAnchor = {
	/** Linha ofensora normalizada. */
	snippet: string;
	/** Linha anterior normalizada (ausente se a ofensora for a primeira). */
	contextBefore?: string;
	/** Linha seguinte normalizada (ausente se a ofensora for a última). */
	contextAfter?: string;
	/** Última linha conhecida (1-based) — cache, nunca identidade. */
	line: number;
};

/** Resultado da localização de uma âncora no conteúdo atual. */
export type AnchorLocation = {
	/** Linha atual (1-based) ou null se a âncora não existe mais. */
	line: number | null;
	/** Nº de ocorrências da âncora no arquivo. */
	occurrences: number;
};

/** Normaliza uma linha: colapsa espaços internos e apara as pontas. */
export function normalizeLine(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/** Conteúdo → linhas normalizadas (uma por linha do arquivo). */
export function normalizedLines(content: string): string[] {
	return content.split(/\r?\n/).map(normalizeLine);
}

/** Marcador de contexto ausente (não confundir com linha vazia). */
const ABSENT = "\u0001";

/** Chave estável da âncora (snippet + contexto, SEM a linha). */
function anchorKey(anchor: FindingAnchor): string {
	return [
		anchor.snippet,
		anchor.contextBefore ?? ABSENT,
		anchor.contextAfter ?? ABSENT,
	].join("\u0000");
}

/** Hash estável (sha256 truncado) — base das identidades do motor. */
export function hashKey(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Fingerprint do finding: `arquivo + regra + âncora`. Sem a linha — permanece
 * estável após edições que deslocam o trecho. Sem âncora, cai no `fallback`
 * (ex.: `message`). Ocorrências com a MESMA âncora compartilham o fingerprint.
 */
export function fingerprintOf(
	file: string,
	rule: string,
	anchor: FindingAnchor | null,
	fallback = "",
): string {
	const key = anchor ? anchorKey(anchor) : `fallback:${fallback}`;
	return hashKey(`${file}\u0000${rule}\u0000${key}`);
}

/**
 * Monta a âncora a partir do conteúdo: usa a `line` (1-based) quando válida;
 * senão procura a linha que contém a `evidence`. Retorna null se não localizar
 * (ex.: arquivo deletado/binário).
 */
export function buildAnchor(
	content: string,
	line: number | undefined,
	evidence?: string,
): FindingAnchor | null {
	const lines = normalizedLines(content);

	let index = -1;
	if (line !== undefined && line >= 1 && line <= lines.length) {
		index = line - 1;
	} else if (evidence) {
		const needle = normalizeLine(evidence);
		if (needle) index = lines.findIndex((l) => l.includes(needle));
	}
	if (index < 0) return null;

	const anchor: FindingAnchor = { snippet: lines[index], line: index + 1 };
	if (index - 1 >= 0) anchor.contextBefore = lines[index - 1];
	if (index + 1 < lines.length) anchor.contextAfter = lines[index + 1];
	return anchor;
}

/** `true` se a linha `i` casa a âncora (snippet + contexto). */
function matchesAt(lines: string[], i: number, anchor: FindingAnchor): boolean {
	if (lines[i] !== anchor.snippet) return false;
	if (anchor.contextBefore !== undefined && lines[i - 1] !== anchor.contextBefore) {
		return false;
	}
	if (anchor.contextAfter !== undefined && lines[i + 1] !== anchor.contextAfter) {
		return false;
	}
	return true;
}

/** Localiza a âncora no conteúdo atual (linha + nº de ocorrências). */
export function locateAnchor(
	content: string,
	anchor: FindingAnchor | null,
): AnchorLocation {
	if (!anchor) return { line: null, occurrences: 0 };
	const lines = normalizedLines(content);
	let occurrences = 0;
	let first = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!matchesAt(lines, i, anchor)) continue;
		occurrences++;
		if (first < 0) first = i;
	}
	return { line: first < 0 ? null : first + 1, occurrences };
}

export type ReanchorStatus = "ok" | "moved" | "stale";

/** Reancora um finding: recalcula a linha e classifica o deslocamento. */
export function reanchor(
	content: string,
	anchor: FindingAnchor | null,
	previousLine: number | null,
): { status: ReanchorStatus; line: number | null } {
	const { line } = locateAnchor(content, anchor);
	if (line === null) return { status: "stale", line: null };
	if (previousLine !== null && line === previousLine) return { status: "ok", line };
	return { status: "moved", line };
}
