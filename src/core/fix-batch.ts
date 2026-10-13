/**
 * Montagem do **lote de correção** dos findings (biblioteca).
 *
 * O `findings batch` precisa entregar, com o mínimo de decisão da LLM, a "melhor
 * unidade de trabalho" para corrigir achados: um grupo coeso (arquivo, regra ou
 * watchdog) já paginado, mais a lista dos outros grupos disponíveis.
 *
 * A escolha do agrupamento é **determinística** — não vem do consumidor. Para a
 * fila atual (findings `decision: execute` ainda não concluídos):
 *
 *   1. Candidatas, em ordem de prioridade: `file` → `rule` → `watchdog`.
 *   2. "Elegível" = média de itens por grupo ≥ 2 (há coesão real).
 *   3. Vence a elegível com **menos grupos** (escopo mais coeso); empate mantém
 *      a prioridade. Sem elegíveis (tudo singleton), cai em `file`.
 *
 * Assim o lote se adapta à run: poucos arquivos → corrige arquivo a arquivo;
 * uma regra espalhada por muitos arquivos → corrige regra a regra; muitos
 * arquivos/regras → agrupa por watchdog.
 */

import {
	compareFindings,
	type FindingState,
	type FindingsStateFile,
	filterFindings,
} from "./findings-state";
import { SEVERITY_ORDER, type Severity, severityRank } from "./types";

/** Eixos possíveis de agrupamento do lote (ordem = prioridade de desempate). */
export type GroupingDimension = "file" | "rule" | "watchdog";

const GROUPING_DIMENSIONS: readonly GroupingDimension[] = ["file", "rule", "watchdog"];

/** Tamanho de página padrão dentro do grupo atual. */
export const FIX_BATCH_PAGE_SIZE = 8;

const DIMENSION_PREFIX = /^(file|rule|watchdog):/;

export type FixBatchOptions = {
	/** Severidade alvo; ausente = todas. */
	severity?: Severity;
	/** Inclui achados já concluídos (default: só os pendentes). */
	includeDone?: boolean;
	/** Deslocamento dentro do grupo atual (default 0). */
	offset?: number;
	/** Chave do grupo alvo (default: o primeiro grupo). */
	group?: string;
	/** Tamanho da página dentro do grupo atual (default `FIX_BATCH_PAGE_SIZE`). */
	pageSize?: number;
};

/** Referência a um grupo na lista dos "outros grupos". */
export type FixBatchGroupRef = {
	key: string;
	label: string;
	count: number;
	bySeverity: Record<Severity, number>;
};

export type FixBatchCurrent = {
	key: string;
	label: string;
	findings: FindingState[];
	total: number;
	offset: number;
	returned: number;
	/** Restantes no grupo atual após a página. */
	remaining: number;
};

export type FixBatchResult = {
	dimension: GroupingDimension;
	current: FixBatchCurrent;
	others: FixBatchGroupRef[];
	totals: {
		/** Itens na fila de correção. */
		queue: number;
		/** Total de grupos. */
		groups: number;
		/** Itens retornados na página do grupo atual. */
		returned: number;
	};
};

/**
 * Fila de correção: findings `decision: execute`, presentes, excluindo `done`
 * (salvo `includeDone`). Ordenados por severidade/arquivo/linha.
 */
export function fixQueue(
	state: FindingsStateFile,
	options: FixBatchOptions = {},
): FindingState[] {
	const filtered = filterFindings(state, {
		decision: "execute",
		severity: options.severity,
	});
	return options.includeDone
		? filtered
		: filtered.filter((finding) => finding.execState !== "done");
}

/** Escolhe a dimensão de agrupamento com melhor coesão para a fila. */
export function chooseGrouping(findings: FindingState[]): GroupingDimension {
	let best: { dimension: GroupingDimension; groups: number } | undefined;
	for (const dimension of GROUPING_DIMENSIONS) {
		const groups = groupFindings(findings, dimension).size;
		if (groups === 0) continue;
		if (findings.length / groups < 2) continue;
		if (!best || groups < best.groups) best = { dimension, groups };
	}
	return best?.dimension ?? "file";
}

/** Agrupa os findings pela dimensão informada (chaves prefixadas pela dimensão). */
export function groupFindings(
	findings: readonly FindingState[],
	dimension: GroupingDimension,
): Map<string, FindingState[]> {
	const groups = new Map<string, FindingState[]>();
	for (const finding of findings) {
		const key = groupKey(finding, dimension);
		const list = groups.get(key);
		if (list) list.push(finding);
		else groups.set(key, [finding]);
	}
	return groups;
}

function groupKey(finding: FindingState, dimension: GroupingDimension): string {
	if (dimension === "file") return `file:${finding.file}`;
	if (dimension === "rule") return `rule:${finding.rule}`;
	return `watchdog:${finding.watchdogIds[0] ?? "—"}`;
}

function labelOf(key: string): string {
	return key.replace(DIMENSION_PREFIX, "");
}

function countBySeverity(findings: readonly FindingState[]): Record<Severity, number> {
	const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<
		Severity,
		number
	>;
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

function groupSeverityRank(findings: readonly FindingState[]): number {
	let rank = Number.POSITIVE_INFINITY;
	for (const finding of findings) rank = Math.min(rank, severityRank(finding.severity));
	return rank;
}

/** Ordena os grupos: severidade mais grave primeiro → tamanho desc → chave. */
function compareGroups(
	a: readonly [string, FindingState[]],
	b: readonly [string, FindingState[]],
): number {
	const bySeverity = groupSeverityRank(a[1]) - groupSeverityRank(b[1]);
	if (bySeverity !== 0) return bySeverity;
	if (a[1].length !== b[1].length) return b[1].length - a[1].length;
	return a[0].localeCompare(b[0]);
}

/**
 * Monta o lote de correção: escolhe o agrupamento, seleciona o grupo atual
 * (primeiro, ou o `group` informado) paginado, e lista os demais grupos.
 * Lança se o `group` informado não existir.
 */
export function buildFixBatch(
	state: FindingsStateFile,
	options: FixBatchOptions = {},
): FixBatchResult {
	const queue = fixQueue(state, options);
	const dimension = chooseGrouping(queue);
	const ordered = [...groupFindings(queue, dimension).entries()].sort(compareGroups);

	if (ordered.length === 0) {
		return {
			dimension,
			current: {
				key: "",
				label: "",
				findings: [],
				total: 0,
				offset: 0,
				returned: 0,
				remaining: 0,
			},
			others: [],
			totals: { queue: 0, groups: 0, returned: 0 },
		};
	}

	if (options.group !== undefined && !ordered.some(([key]) => key === options.group)) {
		const available = ordered.map(([key]) => key);
		const preview = available.slice(0, 5).join(", ");
		throw new Error(
			`Grupo '${options.group}' não encontrado. Disponíveis: ${preview}${
				available.length > 5 ? ", …" : ""
			}.`,
		);
	}

	const [key, members] = (
		options.group ? ordered.find(([k]) => k === options.group) : ordered[0]
	) as [string, FindingState[]];
	const sorted = [...members].sort(compareFindings);
	const offset = Math.max(0, options.offset ?? 0);
	const pageSize = Math.max(1, options.pageSize ?? FIX_BATCH_PAGE_SIZE);
	const page = sorted.slice(offset, offset + pageSize);

	const others = ordered
		.filter(([otherKey]) => otherKey !== key)
		.map(([otherKey, otherMembers]) => ({
			key: otherKey,
			label: labelOf(otherKey),
			count: otherMembers.length,
			bySeverity: countBySeverity(otherMembers),
		}));

	return {
		dimension,
		current: {
			key,
			label: labelOf(key),
			findings: page,
			total: sorted.length,
			offset,
			returned: page.length,
			remaining: Math.max(0, sorted.length - (offset + page.length)),
		},
		others,
		totals: { queue: queue.length, groups: ordered.length, returned: page.length },
	};
}
