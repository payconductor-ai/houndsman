/**
 * Identidade de findings entre watchdogs, passadas e ciclos (biblioteca).
 *
 * A `line` nunca identifica um achado — é cache (ver `finding-anchor.ts`). A
 * identidade é o par **(arquivo, regra)** com o texto da regra normalizado: o
 * mesmo anti-padrão apontado em N trechos do mesmo arquivo é **um** achado com
 * N ocorrências, e dois achados emergentes sobre o mesmo trecho casam pela
 * **âncora de conteúdo** (`anchorContentKey`).
 *
 * Paráfrase entre watchdogs fica fora de propósito: o mesmo trecho pode abrigar
 * assuntos distintos, então `isNearDuplicate` só **avisa** (ver
 * `nearbyDuplicateGroups`) — nunca colapsa achado.
 *
 * Antes desta camada a chave estava copiada em três lugares
 * (`report-builder`, `hunt/review-checks`, `engine/carryover`) com
 * normalizações divergentes — e todas incluíam a linha, então o dedupe só
 * colapsava duplicata byte-idêntica.
 */

import type { Severity } from "./types";
import { severityRank } from "./types";

/**
 * Menor trecho aceito como identidade de conteúdo, em caracteres alfanuméricos.
 * Evita casar `}`, `});` e `return` — que aparecem em qualquer arquivo.
 */
export const MIN_ANCHOR_CHARS = 12;

/** Janela de linhas em que dois achados podem descrever o mesmo problema. */
export const NEAR_DUPLICATE_WINDOW = 20;

/** Fração mínima de texto em comum (coeficiente de sobreposição). */
export const NEAR_DUPLICATE_RATIO = 0.45;

/** Tokens em comum necessários para casar — evita mensagens curtas colidirem. */
export const NEAR_DUPLICATE_TOKENS = 8;

/** Prefixo reservado de achado emergente (`Lógica:`/`Domínio:`). */
const BASIS_PREFIX = /^\s*(?:l[oó]gica|dom[ií]nio)\s*:\s*/i;

/** Numeração do brief (`Regra 3 —`, `3.`, `3)`), que não faz parte do texto. */
const RULE_NUMBER_PREFIX = /^\s*(?:regra\s*)?\d+\s*(?:[.)\-–—:]|\s-)\s*/i;

/** Reticências de truncamento do brief (`…` ou `...`). */
const TRAILING_ELLIPSIS = /\s*(?:…|\.{3})\s*$/;

/** Caminho canônico de um finding (`.\a\b` → `a/b`). */
export function normalizeFindingPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * Chave de comparação do texto de uma regra.
 *
 * Ignora acento, caixa, pontuação, o prefixo reservado (`Lógica:`/`Domínio:`),
 * a numeração do brief e reticências de truncamento — o modelo reescreve o
 * mesmo achado com detalhes cosméticos diferentes entre passadas.
 */
export function ruleIdentityKey(rule: string): string {
	return rule
		.replace(/\s+/g, " ")
		.replace(TRAILING_ELLIPSIS, "")
		.replace(BASIS_PREFIX, "")
		.replace(RULE_NUMBER_PREFIX, "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Chave de ocorrência: mesmo arquivo + mesma regra = **um** achado.
 *
 * Sem regra utilizável (texto vazio/pontuação) cai no texto cru em minúsculas —
 * nunca em chave vazia, que agruparia achados sem relação.
 */
export function occurrenceKey(finding: { file: string; rule: string }): string {
	const path = normalizeFindingPath(finding.file);
	const rule =
		ruleIdentityKey(finding.rule) ||
		finding.rule.replace(/\s+/g, " ").trim().toLowerCase();
	return `${path}|${rule}`;
}

/**
 * `true` quando o trecho identifica o código: alfanuméricos suficientes para
 * não colidir com ruído de sintaxe.
 */
export function isDistinctAnchor(snippet: string): boolean {
	const compact = snippet.replace(/\s+/g, " ").trim();
	return compact.replace(/[^a-zA-Z0-9]/g, "").length >= MIN_ANCHOR_CHARS;
}

/** `true` quando o achado nasce de uma regra declarada no brief. */
export function isDeclaredRule(rule: string): boolean {
	return !BASIS_PREFIX.test(rule);
}

/** Palavras sem valor de identidade (conectivos e verbos de ligação). */
const STOPWORDS = new Set([
	"para",
	"pelo",
	"pela",
	"como",
	"quando",
	"porque",
	"mesmo",
	"ainda",
	"sobre",
	"entre",
	"este",
	"esta",
	"esse",
	"essa",
	"isso",
	"todo",
	"toda",
	"todos",
	"todas",
	"pode",
	"deve",
	"sao",
	"nao",
	"com",
	"que",
	"uma",
	"dos",
	"das",
	"por",
	"mais",
	"menos",
	"onde",
	"qual",
	"quais",
	"seu",
	"sua",
	"seus",
	"suas",
	"aos",
	"nas",
	"nos",
	"sem",
]);

/**
 * Tokens significativos de um texto (normalizado, sem conectivos curtos).
 * Identificadores de código (`req.amountToSend`, `safeParse`) sobrevivem inteiros.
 */
export function textTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of ruleIdentityKey(text).split(" ")) {
		if (token.length < 4 || STOPWORDS.has(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

/**
 * Coeficiente de sobreposição: interseção dividida pelo **menor** conjunto.
 *
 * Diferente de Jaccard, não pune quem escreve mais — o `general` costuma
 * explicar o mesmo defeito com bastante contexto.
 */
export function overlapRatio(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	if (shared < NEAR_DUPLICATE_TOKENS) return 0;
	return shared / Math.min(a.size, b.size);
}

/** Campos usados para reconhecer o mesmo problema descrito de outro jeito. */
export type NearDuplicateCandidate = {
	file: string;
	line?: number;
	message: string;
	action: string;
	evidence?: string;
};

/**
 * `true` quando dois achados PARECEM descrever o mesmo problema.
 *
 * O `general` e o domínio costumam ancorar o mesmo defeito em linhas vizinhas,
 * com `rule` e âncora diferentes. Exige arquivo igual, linhas a menos de
 * {@link NEAR_DUPLICATE_WINDOW} e texto sobreposto.
 *
 * **Não é usado para mesclar**: o mesmo trecho pode abrigar assuntos distintos
 * (testabilidade × bug na mesma linha colapsam sob qualquer limiar). Serve para
 * o `--finalize` avisar o revisor (`nearbyDuplicateGroups`).
 */
export function isNearDuplicate(
	a: NearDuplicateCandidate,
	b: NearDuplicateCandidate,
): boolean {
	if (normalizeFindingPath(a.file) !== normalizeFindingPath(b.file)) return false;
	if (a.line === undefined || b.line === undefined) return false;
	if (Math.abs(a.line - b.line) > NEAR_DUPLICATE_WINDOW) return false;
	const left = textTokens(`${a.message} ${a.action} ${a.evidence ?? ""}`);
	const right = textTokens(`${b.message} ${b.action} ${b.evidence ?? ""}`);
	return overlapRatio(left, right) >= NEAR_DUPLICATE_RATIO;
}

/** Peso da origem do achado: regra declarada > domínio > lógica. */
function basisWeight(basis: string | undefined): number {
	if (basis === "rule") return 3;
	if (basis === "domain") return 2;
	return 1;
}

/** Origem efetiva: o `basis` declarado ou o inferido pelo prefixo reservado. */
function basisOf(input: { basis?: string; rule?: string }): string | undefined {
	if (input.basis) return input.basis;
	if (input.rule === undefined) return undefined;
	return isDeclaredRule(input.rule) ? "rule" : "logic";
}

/**
 * `true` quando `candidate` deve representar o achado no lugar de `current`.
 *
 * Regra declarada vence (carrega severidade e identidade de triagem), depois a
 * severidade mais grave, depois a confiança. Empate preserva o primeiro.
 * `rule` é opcional: quando `basis` falta, o prefixo decide a origem.
 */
export function outweighs(
	candidate: { severity: Severity; basis?: string; confidence?: number; rule?: string },
	current: { severity: Severity; basis?: string; confidence?: number; rule?: string },
): boolean {
	const byBasis = basisWeight(basisOf(candidate)) - basisWeight(basisOf(current));
	if (byBasis !== 0) return byBasis > 0;
	const bySeverity = severityRank(candidate.severity) - severityRank(current.severity);
	if (bySeverity !== 0) return bySeverity < 0;
	return (candidate.confidence ?? 0) > (current.confidence ?? 0);
}
