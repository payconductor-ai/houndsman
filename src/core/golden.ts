/**
 * Golden set — avaliação de uma run contra defeitos conhecidos (funções puras).
 *
 * Contagem de findings não mede profundidade: variantes diferentes amostram
 * pontos diferentes do mesmo PR. O golden set congela os defeitos que já foram
 * confirmados no código e transforma a comparação em **recall/precisão**, que
 * é o número capaz de dizer se um ajuste de prompt/harness melhorou ou piorou.
 *
 * O formato é genérico: o arquivo é fornecido pelo consumidor (não vive no
 * motor). Cada expectativa é uma âncora — arquivo + faixa de linha + trecho —
 * nunca um fingerprint, para não acoplar a avaliação à identidade interna.
 */

import { normalizePath } from "./hunt/review-checks";
import { SEVERITY_ORDER, type Severity, severityRank } from "./types";

/** Defeito congelado (verificado manualmente no código). */
export type GoldenExpectation = {
	/** Identidade curta, estável e legível (`seller-api-key`). */
	id: string;
	/** Caminho relativo à raiz da revisão. */
	file: string;
	/** Linha de referência do defeito. */
	line?: number;
	/** Tolerância em linhas (default: 30). */
	tolerance?: number;
	/** Trecho que precisa aparecer em `message`/`rule`/`evidence` (case-insensitive). */
	match?: string;
	/** Severidade mínima aceita para contar como encontrado. */
	severity?: Severity;
	/** Contexto para quem lê o relatório. */
	note?: string;
};

/** Arquivo de golden set. */
export type GoldenSet = {
	version: 1;
	title?: string;
	/** Commit em que os defeitos foram congelados. */
	commit?: string;
	expected: GoldenExpectation[];
};

/** Finding normalizado para a avaliação. */
export type GoldenFinding = {
	fingerprint: string;
	file: string;
	line?: number;
	rule: string;
	severity: Severity;
	message: string;
	evidence?: string;
	watchdogs: readonly string[];
};

/** Expectativa casada com o finding que a comprova. */
export type GoldenMatch = {
	expectation: GoldenExpectation;
	finding: GoldenFinding;
};

/** Resultado da avaliação de uma run. */
export type GoldenScore = {
	/** Defeitos congelados. */
	total: number;
	matched: GoldenMatch[];
	missed: GoldenExpectation[];
	/** Findings que não casam com nenhuma expectativa (ruído). */
	unexpected: GoldenFinding[];
	/** Defeitos distintos cobertos (mesmo defeito = mesma âncora). */
	issues: number;
	recall: number;
	precision: number;
};

/** Parse tolerante: aceita `{ expected: [...] }` ou a lista direta. */
export function parseGoldenSet(raw: unknown): {
	set: GoldenSet | null;
	warnings: string[];
} {
	const warnings: string[] = [];
	const list = Array.isArray(raw)
		? raw
		: typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>).expected
			: null;
	if (!Array.isArray(list)) {
		return { set: null, warnings: ["golden set sem lista `expected`."] };
	}

	const expected: GoldenExpectation[] = [];
	for (const [index, item] of list.entries()) {
		if (typeof item !== "object" || item === null) {
			warnings.push(`item ${index}: não é objeto.`);
			continue;
		}
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : "";
		const file = typeof record.file === "string" ? record.file.trim() : "";
		if (!id || !file) {
			warnings.push(`item ${index}: \`id\` e \`file\` são obrigatórios.`);
			continue;
		}
		const severity =
			typeof record.severity === "string" &&
			SEVERITY_ORDER.includes(record.severity as Severity)
				? (record.severity as Severity)
				: undefined;
		expected.push({
			id,
			file: normalizePath(file),
			line: typeof record.line === "number" ? record.line : undefined,
			tolerance:
				typeof record.tolerance === "number" ? record.tolerance : undefined,
			match: typeof record.match === "string" ? record.match : undefined,
			severity,
			note: typeof record.note === "string" ? record.note : undefined,
		});
	}

	if (expected.length === 0) {
		return {
			set: null,
			warnings: [...warnings, "golden set sem expectativas válidas."],
		};
	}

	const header = Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
	return {
		set: {
			version: 1,
			title: typeof header.title === "string" ? header.title : undefined,
			commit: typeof header.commit === "string" ? header.commit : undefined,
			expected,
		},
		warnings,
	};
}

/** Tolerância efetiva de uma expectativa. */
const DEFAULT_TOLERANCE = 30;

/** `true` quando o finding comprova a expectativa. */
function satisfies(expectation: GoldenExpectation, finding: GoldenFinding): boolean {
	if (normalizePath(finding.file) !== expectation.file) return false;
	if (expectation.line !== undefined) {
		if (finding.line === undefined) return false;
		const tolerance = expectation.tolerance ?? DEFAULT_TOLERANCE;
		if (Math.abs(finding.line - expectation.line) > tolerance) return false;
	}
	if (expectation.severity) {
		if (severityRank(finding.severity) > severityRank(expectation.severity)) {
			return false;
		}
	}
	if (expectation.match) {
		const haystack = `${finding.message} ${finding.rule} ${finding.evidence ?? ""}`;
		if (!haystack.toLowerCase().includes(expectation.match.toLowerCase())) {
			return false;
		}
	}
	return true;
}

/** Distância de linha usada para escolher o melhor candidato. */
function distance(expectation: GoldenExpectation, finding: GoldenFinding): number {
	if (expectation.line === undefined || finding.line === undefined) return 0;
	return Math.abs(finding.line - expectation.line);
}

/**
 * Avalia os findings de uma run.
 *
 * Greedy por expectativa, escolhendo o finding mais próximo da âncora — cada
 * finding comprova no máximo um defeito, para a precisão não ser inflada por
 * três achados na mesma linha.
 */
export function scoreGolden(
	set: GoldenSet,
	findings: readonly GoldenFinding[],
): GoldenScore {
	const used = new Set<number>();
	const matched: GoldenMatch[] = [];
	const missed: GoldenExpectation[] = [];

	for (const expectation of set.expected) {
		let bestIndex = -1;
		for (const [index, finding] of findings.entries()) {
			if (used.has(index) || !satisfies(expectation, finding)) continue;
			if (
				bestIndex < 0 ||
				distance(expectation, finding) <
					distance(expectation, findings[bestIndex])
			) {
				bestIndex = index;
			}
		}
		if (bestIndex < 0) {
			missed.push(expectation);
			continue;
		}
		used.add(bestIndex);
		matched.push({ expectation, finding: findings[bestIndex] });
	}

	const unexpected = findings.filter((_, index) => !used.has(index));
	const anchors = new Set(
		findings.map((finding) => `${normalizePath(finding.file)}:${finding.line ?? 0}`),
	);
	return {
		total: set.expected.length,
		matched,
		missed,
		unexpected,
		issues: anchors.size,
		recall: set.expected.length === 0 ? 0 : matched.length / set.expected.length,
		precision: findings.length === 0 ? 0 : matched.length / findings.length,
	};
}

/** Avaliação de uma run (uma linha da tabela). */
export type GoldenRunScore = {
	slug: string;
	label: string;
	variant?: string;
	scope: string;
	/** Commit revisado pela run (quando conhecido). */
	commit?: string;
	/**
	 * `true` quando a run revisou outro commit que não o congelado.
	 *
	 * Não é erro: as âncoras de linha continuam válidas enquanto o arquivo não
	 * se mover, mas o resultado passa a ser **suspeito** — a maior parte das
	 * "faltas" pode ser deslocamento de linha, não perda de profundidade.
	 */
	commitMismatch?: boolean;
	findings: number;
	score: GoldenScore;
};

/** `true` quando o commit avaliado é o congelado no golden (compara 7 chars). */
export function commitMatches(
	expected: string | undefined,
	head: string | undefined,
): boolean {
	// Sem referência de um dos lados não há como afirmar divergência.
	if (!expected || !head) return true;
	return expected.slice(0, 7).toLowerCase() === head.slice(0, 7).toLowerCase();
}

/** Percentual legível (`62%`). */
function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/**
 * Renderiza a avaliação em Markdown.
 *
 * A tabela é o artefato de decisão: uma linha por run/variante. O detalhe de
 * cada run lista o que faltou — é o insumo para melhorar o brief/harness.
 */
export function renderGoldenReport(
	set: GoldenSet,
	runs: readonly GoldenRunScore[],
): string {
	const title = set.title ? ` — \`${set.title}\`` : "";
	const drifted = runs.filter((run) => run.commitMismatch);
	const lines = [
		`# Golden set${title}`,
		"",
		`**Defeitos congelados:** ${set.expected.length}` +
			(set.commit
				? ` · **commit de referência:** \`${set.commit.slice(0, 7)}\``
				: ""),
		"",
		...(drifted.length > 0
			? [
					`> ⚠️ **Commit divergente em ${drifted.length} run(s).** O golden foi congelado em`,
					`> \`${set.commit?.slice(0, 7)}\` e a run revisou outro commit (${drifted
						.slice(0, 3)
						.map(
							(run) => `\`${run.label}@${run.commit?.slice(0, 7) ?? "?"}\``,
						)
						.join(", ")}${drifted.length > 3 ? ", …" : ""}).`,
					">",
					"> Âncoras de linha podem ter se deslocado: revalide o golden antes de tratar",
					"> a diferença como perda de profundidade.",
					"",
				]
			: []),
		"> Recall mede o que a revisão **encontrou**; precisão mede quanto do que ela",
		"> reportou corresponde a um defeito congelado. O resto pode ser achado legítimo",
		"> ainda não triado — confirme antes de tratar como ruído.",
		"",
		"| Run | Escopo | Findings | Problemas | Recall | Precisão | Faltaram |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...runs.map(
			(run) =>
				`| \`${run.slug}\` | ${run.scope} | ${run.findings} | ${run.score.issues} | ` +
				`${percent(run.score.recall)} (${run.score.matched.length}/${run.score.total}) | ` +
				`${percent(run.score.precision)} | ${run.score.missed.length} |`,
		),
		"",
	];

	for (const run of runs) {
		const missed = run.score.missed;
		lines.push(
			`## ${run.label} (${percent(run.score.recall)})`,
			"",
			...(run.commitMismatch
				? [
						`> ⚠️ revisou \`${run.commit?.slice(0, 7) ?? "?"}\`, não o commit congelado`,
						`\`${set.commit?.slice(0, 7)}\`.`,
						"",
					]
				: []),
			missed.length === 0
				? "_Nenhum defeito congelado faltando._"
				: "**Faltaram:**",
			...missed.map((expectation) => {
				const line = expectation.line !== undefined ? `:${expectation.line}` : "";
				const note = expectation.note ? ` — ${expectation.note}` : "";
				return `- \`${expectation.id}\` · \`${expectation.file}${line}\`${note}`;
			}),
			"",
		);
		const unexpected = run.score.unexpected.slice(0, 10);
		if (unexpected.length > 0) {
			lines.push(
				`**Fora do golden (${run.score.unexpected.length}):**`,
				...unexpected.map((finding) => {
					const line = finding.line !== undefined ? `:${finding.line}` : "";
					return `- **${finding.severity}** · \`${finding.file}${line}\` — ${finding.message.slice(0, 140)}`;
				}),
				"",
			);
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** JSON estável da avaliação (automação/CI). */
export function goldenToJson(set: GoldenSet, runs: readonly GoldenRunScore[]): string {
	return `${JSON.stringify({ set, runs }, null, 2)}\n`;
}
