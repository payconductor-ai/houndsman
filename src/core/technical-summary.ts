/**
 * Pontos técnicos estruturais do resumo final (`technical-summary.json`).
 *
 * Descrevem a arquitetura da mudança (módulos, contratos, implementações,
 * dependências e impacto) — nunca os achados da revisão. A IA apenas refina a
 * redação; sem ela, a heurística abaixo é o resultado final.
 */

import type { AstAnalysis, AstImpact, AstSymbol, AstSymbolKind } from "./ast/types";
import type { ClassificationResult } from "./file-classifier";

/** Destaque técnico exibido como um bullet do resumo. */
export type TechnicalHighlight = {
	/** Rótulo curto (ex.: "Contratos", "Implementações"). */
	area: string;
	/** Detalhe em uma linha, com paths/símbolos. */
	detail: string;
};

/** Pontos técnicos de uma revisão. */
export type TechnicalSummary = {
	/** `ai` quando o texto veio do modelo; `deterministic` no fallback. */
	source: "ai" | "deterministic";
	/** Commit coberto — permite saber a que revisão o resumo se refere. */
	headSha?: string;
	/** Parágrafo curto de abertura (opcional). */
	overview?: string;
	highlights: TechnicalHighlight[];
};

/** Entrada mínima para montar os destaques. */
export type TechnicalInput = {
	classification: Pick<ClassificationResult, "files" | "churn">;
	ast?: ReadonlyMap<string, AstAnalysis>;
	impact?: AstImpact;
	headSha?: string;
};

/** Entrada do payload enviado à IA (inclui contexto de negócio e domínios). */
export type TechnicalPromptInput = TechnicalInput & {
	branch: string;
	context?: {
		objective?: string;
		motivation?: string;
		changeSummary?: string[];
	} | null;
	domains?: readonly string[];
};

const MAX_HIGHLIGHTS = 6;
const MAX_DETAIL = 240;

/** Corta o texto em `max` caracteres, sinalizando com reticências. */
function truncate(value: string, max: number): string {
	const text = value.trim().replace(/\s+/g, " ");
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Diretório do arquivo (`(raiz)` para paths sem pasta). */
function moduleOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : "(raiz)";
}

/** `true` para pacotes externos (fora do projeto e de aliases locais). */
function isExternal(source: string): boolean {
	return (
		!source.startsWith(".") &&
		!source.startsWith("/") &&
		!source.startsWith("#") &&
		!source.startsWith("@/")
	);
}

/** `true` para símbolos que representam contratos públicos. */
function isContract(kind: AstSymbolKind): boolean {
	return kind === "interface" || kind === "type" || kind === "enum";
}

type SymbolRef = { symbol: AstSymbol; file: string };

/** Lista curta de símbolos com o arquivo de origem. */
function symbolDetail(refs: SymbolRef[], max = 4): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const ref of refs) {
		const key = `${ref.file}|${ref.symbol.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		parts.push(`\`${ref.symbol.name}\` (${ref.file})`);
		if (parts.length === max) break;
	}
	const total = new Set(refs.map((ref) => `${ref.file}|${ref.symbol.name}`)).size;
	return `${parts.join(", ")}${total > parts.length ? ` +${total - parts.length}` : ""}`;
}

type SignatureRef = {
	name: string;
	before: string;
	after: string;
	file: string;
};

/** Assinaturas alteradas, com o `antes → depois`. */
function signatureDetail(changes: SignatureRef[], max = 3): string {
	return changes
		.slice(0, max)
		.map(
			(change) =>
				`\`${change.name}\` (${truncate(change.before, 60)} → ${truncate(change.after, 60)})`,
		)
		.join(", ");
}

type ExportRef = {
	name: string;
	change: "added" | "removed";
	file: string;
};

type PromptSymbolRef = { name: string; kind: string; file: string };

/** Exports adicionados/removidos, com o arquivo. */
function exportDetail(changes: ExportRef[], max = 4): string {
	return changes
		.slice(0, max)
		.map((change) => `\`${change.name}\` (${change.change}, ${change.file})`)
		.join(", ");
}

/** Agrupa paths por diretório, do maior para o menor grupo. */
function groupByModule(paths: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const dir = moduleOf(path);
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Monta os destaques determinísticos. Prioriza símbolos do AST; sem fatos
 * estruturais, agrupa os arquivos novos por diretório. Nunca lança.
 */
export function buildTechnicalSummary(input: TechnicalInput): TechnicalSummary {
	const highlights: TechnicalHighlight[] = [];
	const files = input.classification.files;
	const added = Object.entries(files)
		.filter(([, file]) => file.status === "added")
		.map(([path]) => path);
	const deleted = Object.entries(files)
		.filter(([, file]) => file.status === "deleted")
		.map(([path]) => path);

	const contracts: SymbolRef[] = [];
	const implementations: SymbolRef[] = [];
	const functions: SymbolRef[] = [];
	const signatures: SignatureRef[] = [];
	const exportsChanged: ExportRef[] = [];
	const imports = new Set<string>();

	if (input.ast) {
		for (const [file, analysis] of input.ast) {
			const delta = analysis.delta;
			if (!delta) continue;
			for (const symbol of delta.addedSymbols) {
				if (isContract(symbol.kind)) contracts.push({ symbol, file });
				else if (symbol.kind === "class") implementations.push({ symbol, file });
				else if (symbol.kind === "function") functions.push({ symbol, file });
			}
			for (const change of delta.changedSignatures) {
				if (!change.exported) continue;
				signatures.push({
					name: change.name,
					before: change.before,
					after: change.after,
					file,
				});
			}
			for (const change of delta.changedExports) {
				exportsChanged.push({
					name: change.name,
					change: change.change,
					file,
				});
			}
			for (const source of delta.addedImports) {
				if (isExternal(source)) imports.add(source);
			}
		}
	}

	if (contracts.length > 0) {
		highlights.push({ area: "Contratos", detail: symbolDetail(contracts) });
	}
	if (implementations.length > 0) {
		highlights.push({
			area: "Implementações",
			detail: symbolDetail(implementations),
		});
	}
	if (functions.length > 0 && contracts.length === 0 && implementations.length === 0) {
		highlights.push({ area: "Funções", detail: symbolDetail(functions) });
	}
	if (signatures.length > 0) {
		highlights.push({
			area: "Assinaturas alteradas",
			detail: signatureDetail(signatures),
		});
	}
	if (exportsChanged.length > 0) {
		highlights.push({
			area: "Exports alterados",
			detail: exportDetail(exportsChanged),
		});
	}
	if (imports.size > 0) {
		highlights.push({
			area: "Novas dependências",
			detail: [...imports]
				.slice(0, 6)
				.map((source) => `\`${source}\``)
				.join(", "),
		});
	}

	// Sem fatos do AST, a estrutura visível é o conjunto de diretórios novos.
	if (highlights.length === 0) {
		for (const [dir, count] of groupByModule(added).slice(0, 3)) {
			highlights.push({
				area: "Estrutura",
				detail: `Novo diretório \`${dir}\` com ${count} arquivo(s).`,
			});
		}
	}

	if (deleted.length > 0 && highlights.length < MAX_HIGHLIGHTS) {
		highlights.push({
			area: "Remoções",
			detail: `${deleted
				.slice(0, 4)
				.map((path) => `\`${path}\``)
				.join(", ")}${deleted.length > 4 ? ` +${deleted.length - 4}` : ""}`,
		});
	}

	if (
		input.impact &&
		input.impact.affectedFiles.length > 0 &&
		highlights.length < MAX_HIGHLIGHTS
	) {
		const exported = input.impact.exportedChanges.length;
		highlights.push({
			area: "Impacto",
			detail:
				`${input.impact.affectedFiles.length} arquivo(s) importam os alterados` +
				(exported > 0 ? `; ${exported} export(s) público(s) alterado(s)` : "") +
				".",
		});
	}

	return {
		source: "deterministic",
		headSha: input.headSha,
		highlights: highlights.slice(0, MAX_HIGHLIGHTS).map((highlight) => ({
			area: truncate(highlight.area, 80),
			detail: truncate(highlight.detail, MAX_DETAIL),
		})),
	};
}

/** Payload compacto enviado ao modelo (nunca arquivos inteiros). */
export function buildTechnicalPromptPayload(
	input: TechnicalPromptInput,
): Record<string, unknown> {
	const files = Object.entries(input.classification.files)
		.map(([path, file]) => ({
			path,
			status: file.status,
			additions: input.classification.churn[path]?.additions ?? 0,
			deletions: input.classification.churn[path]?.deletions ?? 0,
		}))
		.sort(
			(a, b) =>
				b.additions + b.deletions - (a.additions + a.deletions) ||
				a.path.localeCompare(b.path),
		)
		.slice(0, 80);

	const contracts: PromptSymbolRef[] = [];
	const implementations: PromptSymbolRef[] = [];
	const signatures: SignatureRef[] = [];
	const exportsChanged: ExportRef[] = [];
	const imports = new Set<string>();
	const deletedFiles: string[] = [];

	for (const [path, file] of Object.entries(input.classification.files)) {
		if (file.status === "deleted") deletedFiles.push(path);
	}

	if (input.ast) {
		for (const [file, analysis] of input.ast) {
			const delta = analysis.delta;
			if (!delta) continue;
			for (const symbol of delta.addedSymbols) {
				if (isContract(symbol.kind)) {
					contracts.push({ name: symbol.name, kind: symbol.kind, file });
				} else if (symbol.kind === "class") {
					implementations.push({ name: symbol.name, kind: symbol.kind, file });
				}
			}
			for (const change of delta.changedSignatures) {
				if (change.exported) {
					signatures.push({
						name: change.name,
						before: change.before,
						after: change.after,
						file,
					});
				}
			}
			for (const change of delta.changedExports) {
				exportsChanged.push({
					name: change.name,
					change: change.change,
					file,
				});
			}
			for (const source of delta.addedImports) {
				if (isExternal(source)) imports.add(source);
			}
		}
	}

	return {
		branch: input.branch,
		headSha: input.headSha,
		business: input.context
			? {
					objective: input.context.objective,
					motivation: input.context.motivation,
					changeSummary: input.context.changeSummary,
				}
			: undefined,
		domains: input.domains ?? [],
		files,
		structure: {
			contracts: contracts.slice(0, 40),
			implementations: implementations.slice(0, 40),
			changedSignatures: signatures.slice(0, 20),
			changedExports: exportsChanged.slice(0, 20),
			addedImports: [...imports].slice(0, 20),
			deletedFiles: deletedFiles.slice(0, 20),
		},
		impact: input.impact
			? {
					affectedFiles: input.impact.affectedFiles.length,
					importers: Object.keys(input.impact.importers).length,
					exportedChanges: input.impact.exportedChanges.length,
				}
			: undefined,
	};
}

/** Valida/normaliza o `technical-summary.json`; null quando vazio/inválido. */
export function parseTechnicalSummary(raw: unknown): TechnicalSummary | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;

	const highlights: TechnicalHighlight[] = [];
	if (Array.isArray(obj.highlights)) {
		for (const item of obj.highlights) {
			if (typeof item !== "object" || item === null) continue;
			const entry = item as Record<string, unknown>;
			const area = typeof entry.area === "string" ? entry.area.trim() : "";
			const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
			if (!area || !detail) continue;
			highlights.push({
				area: truncate(area, 80),
				detail: truncate(detail, MAX_DETAIL),
			});
			if (highlights.length === MAX_HIGHLIGHTS) break;
		}
	}

	const overview =
		typeof obj.overview === "string" && obj.overview.trim().length > 0
			? truncate(obj.overview, 600)
			: undefined;
	if (highlights.length === 0 && !overview) return null;

	return {
		source: obj.source === "deterministic" ? "deterministic" : "ai",
		headSha: typeof obj.headSha === "string" ? obj.headSha : undefined,
		overview,
		highlights,
	};
}
