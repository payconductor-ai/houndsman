/**
 * Propagação mecânica — detecção determinística de mudanças em massa.
 *
 * Cenário típico: um contrato ganha um parâmetro obrigatório e N arquivos
 * adicionam a mesma linha. Revisar N diffs de uma linha é desperdício; o risco
 * está no padrão (um representante) e nos outliers (quem fugiu do padrão).
 *
 * Tudo aqui é função pura sobre dados já coletados no prepare (patch `-U0`,
 * churn, delta/impacto do AST) — não há leitura extra de git nem chamada de IA.
 */

import type { AstAnalysis, AstImpact } from "./ast/types";
import { churnOf } from "./domain/budget";
import type { ChurnMap, PropagationCluster, PropagationGap } from "./types";

/** Acima disso o arquivo não é "micro-alteração". */
export const PROPAGATION_MAX_CHURN = 3;

/** Mínimo de arquivos com o mesmo padrão para virar cluster. */
export const PROPAGATION_MIN_FILES = 5;

/** Teto de arquivos examinados (proteção para PRs gigantes). */
export const PROPAGATION_MAX_FILES = 500;

/** Outliers listados no brief (os demais são contados). */
export const PROPAGATION_MAX_OUTLIERS = 8;

/** Importadores listados por contrato no brief. */
export const PROPAGATION_MAX_IMPORTERS = 10;

/** Linhas adicionadas do patch (sem cabeçalho), normalizadas. */
export function addedLines(patch: string | undefined): string[] {
	if (!patch) return [];
	const lines: string[] = [];
	for (const raw of patch.split(/\r?\n/)) {
		if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
		const normalized = raw.slice(1).trim().replace(/\s+/g, " ");
		if (normalized.length > 0) lines.push(normalized);
	}
	return lines;
}

/**
 * Detecta o padrão dominante entre micro-alterações.
 *
 * Agrupa por linha adicionada **exata** (só normaliza espaços): agrupar por
 * identificador esconderia justamente o outlier que precisa de revisão. Sem
 * grupo dominante, devolve `null` e o brief segue como antes.
 */
export function detectPropagation(
	files: readonly string[],
	patch: ReadonlyMap<string, string> | undefined,
	churn?: ChurnMap,
): PropagationCluster | null {
	if (!patch) return null;
	const micro: { file: string; lines: string[] }[] = [];
	for (const file of files.slice(0, PROPAGATION_MAX_FILES)) {
		if (churnOf(file, churn) > PROPAGATION_MAX_CHURN) continue;
		const lines = addedLines(patch.get(file));
		if (lines.length === 0) continue;
		micro.push({ file, lines });
	}
	if (micro.length < PROPAGATION_MIN_FILES) return null;

	const groups = new Map<string, { file: string; lines: string[] }[]>();
	for (const entry of micro) {
		const key = entry.lines.join("\n");
		const list = groups.get(key);
		if (list) list.push(entry);
		else groups.set(key, [entry]);
	}
	const [patternKey, members] =
		[...groups.entries()].sort(
			(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
		)[0] ?? [];
	if (!members || members.length < PROPAGATION_MIN_FILES) return null;

	const dominant = new Set(members.map((entry) => entry.file));
	const outliers = micro
		.filter((entry) => !dominant.has(entry.file))
		.slice(0, PROPAGATION_MAX_OUTLIERS);
	return {
		lines: (patternKey ?? "").split("\n"),
		files: members.map((entry) => entry.file),
		outliers,
	};
}

/** `true` quando o delta mexeu em um contrato exportado (assinatura/export). */
function changesExportedContract(analysis: AstAnalysis | undefined): boolean {
	const delta = analysis?.delta;
	if (!delta) return false;
	if (delta.changedExports.length > 0) return true;
	if (delta.changedSignatures.some((change) => change.exported)) return true;
	return delta.modifiedSymbols.some(
		(symbol) =>
			symbol.exported &&
			(symbol.kind === "interface" ||
				symbol.kind === "type" ||
				symbol.kind === "enum" ||
				symbol.kind === "class"),
	);
}

/**
 * Contratos alterados com importadores que **não** aparecem no diff.
 *
 * É o cheque de "atualizaram 100 e esqueceram 3": o impacto reverso do AST já
 * lista quem importa o arquivo; quem não está no diff vira suspeito no brief.
 */
export function detectPropagationGaps(
	files: readonly string[],
	ast: ReadonlyMap<string, AstAnalysis> | undefined,
	impact: AstImpact | undefined,
	changedFiles: ReadonlySet<string>,
): PropagationGap[] {
	if (!ast || !impact) return [];
	const gaps: PropagationGap[] = [];
	for (const file of files) {
		if (!changesExportedContract(ast.get(file))) continue;
		const importers = [...new Set(impact.importers[file] ?? [])]
			.filter((importer) => !changedFiles.has(importer))
			.slice(0, PROPAGATION_MAX_IMPORTERS);
		if (importers.length > 0) gaps.push({ file, importers });
	}
	return gaps;
}
