/**
 * Extração de fatos estruturais (biblioteca).
 *
 * Usa a árvore do tree-sitter sem depender da API de queries: percorre os nós
 * nomeados e extrai imports, exports, declarações, assinaturas e decorators.
 * Tolerante a sintaxe inválida — o que der para ler vira fato; o resto é
 * ignorado.
 */

import type { Node } from "web-tree-sitter";
import type {
	AstExport,
	AstFacts,
	AstImport,
	AstLanguage,
	AstSymbol,
	AstSymbolKind,
} from "./types";

/** Tipos de nó que viram símbolo, com a espécie correspondente. */
const DECLARATION_KINDS: Record<string, AstSymbolKind> = {
	function_declaration: "function",
	generator_function_declaration: "function",
	class_declaration: "class",
	interface_declaration: "interface",
	type_alias_declaration: "type",
	enum_declaration: "enum",
	method_definition: "method",
	method_signature: "method",
	abstract_method_signature: "method",
	public_field_definition: "property",
	property_signature: "property",
};

/** Tipos de contêiner usados para qualificar métodos (`Classe.método`). */
const OWNER_TYPES = ["class_declaration", "interface_declaration"];

/** Percorre a árvore em profundidade, visitando nós nomeados. */
function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

/** Remove aspas simples/duplas de um literal de string. */
function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' || first === "'") && last === first) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** Colapsa espaços em branco e trunca em `max` caracteres. */
function collapse(value: string, max = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Sobe a árvore até encontrar um nó de um dos tipos informados. */
function findAncestor(node: Node, types: readonly string[]): Node | null {
	let current = node.parent;
	while (current) {
		if (types.includes(current.type)) return current;
		current = current.parent;
	}
	return null;
}

/** `true` quando a declaração está sob um `export_statement`. */
function isExported(node: Node): boolean {
	return findAncestor(node, ["export_statement"]) !== null;
}

/** Nome da declaração (campo `name`). */
function nameOf(node: Node): string | undefined {
	return node.childForFieldName("name")?.text?.trim() || undefined;
}

/** Assinatura normalizada de função/método/arrow (parâmetros + retorno). */
function signatureOf(node: Node, name: string): string | undefined {
	const params = node.childForFieldName("parameters")?.text ?? "";
	const returnType = node.childForFieldName("return_type")?.text ?? "";
	if (!params && !returnType) return undefined;
	return collapse(`${name}${params}${returnType}`);
}

/** Nome qualificado de métodos/propriedades (`Classe.membro`). */
function qualifiedName(node: Node, name: string): string {
	const owner = findAncestor(node, OWNER_TYPES);
	const ownerName = owner ? nameOf(owner) : undefined;
	return ownerName ? `${ownerName}.${name}` : name;
}

/** Adiciona um símbolo evitando duplicatas por espécie + nome. */
function addSymbol(map: Map<string, AstSymbol>, symbol: AstSymbol): void {
	const key = `${symbol.kind}:${symbol.name}`;
	const existing = map.get(key);
	if (
		!existing ||
		symbol.endLine - symbol.startLine > existing.endLine - existing.startLine
	) {
		map.set(key, symbol);
	}
}

/** Extrai nomes de um `import_specifier` (importado e alias local). */
function importSpecifierNames(node: Node, names: Set<string>): void {
	const imported = node.childForFieldName("name")?.text?.trim();
	const alias = node.childForFieldName("alias")?.text?.trim();
	if (imported) names.add(imported);
	if (alias) names.add(alias);
}

/** Nomes locais de um `import_clause` (default/namespace). */
function importClauseNames(node: Node, names: Set<string>): void {
	for (const child of node.namedChildren) {
		if (child.type === "identifier") {
			names.add(child.text.trim());
			continue;
		}
		if (child.type === "namespace_import") {
			const local = child.namedChildren.find((item) => item.type === "identifier");
			if (local) names.add(local.text.trim());
		}
	}
}

/** Imports (`import`, `require` e `import()` dinâmico). */
function collectImports(root: Node): AstImport[] {
	const imports: AstImport[] = [];
	walk(root, (node) => {
		if (node.type === "import_statement") {
			const sourceNode = node.childForFieldName("source");
			const source = sourceNode ? unquote(sourceNode.text) : "";
			if (!source) return;
			const names = new Set<string>();
			for (const child of node.descendantsOfType("import_specifier")) {
				importSpecifierNames(child, names);
			}
			for (const child of node.descendantsOfType("import_clause")) {
				importClauseNames(child, names);
			}
			imports.push({
				source,
				names: [...names],
				typeOnly: /^import\s+type\b/.test(node.text.trim()),
			});
			return;
		}

		if (node.type !== "call_expression") return;
		const fn = node.childForFieldName("function")?.text?.trim();
		if (fn !== "require" && fn !== "import") return;
		const args = node.childForFieldName("arguments");
		const first = args?.namedChildren[0];
		if (!first || first.type !== "string") return;
		const source = unquote(first.text);
		if (!source) return;
		const names = new Set<string>();
		const declarator = node.parent;
		if (declarator?.type === "variable_declarator") {
			const name = declarator.childForFieldName("name")?.text?.trim();
			if (name) names.add(name);
		}
		imports.push({ source, names: [...names], typeOnly: false });
	});
	return imports;
}

/** Declarações (funções, classes, métodos, variáveis, tipos…). */
function collectSymbols(root: Node): AstSymbol[] {
	const symbols = new Map<string, AstSymbol>();

	walk(root, (node) => {
		// Declarações locais (dentro de função/bloco) não são símbolos de topo.
		if (findAncestor(node, ["statement_block"]) !== null) return;

		if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
			for (const declarator of node.namedChildren) {
				if (declarator.type !== "variable_declarator") continue;
				const name = nameOf(declarator);
				if (!name || name.startsWith("{") || name.startsWith("[")) continue;
				const value = declarator.childForFieldName("value");
				const kind: AstSymbolKind =
					value?.type === "arrow_function" ||
					value?.type === "function_expression"
						? "function"
						: "variable";
				addSymbol(symbols, {
					name,
					kind,
					exported: isExported(declarator),
					startLine: declarator.startPosition.row + 1,
					endLine: declarator.endPosition.row + 1,
					signature: value ? signatureOf(value, name) : undefined,
				});
			}
			return;
		}

		const kind = DECLARATION_KINDS[node.type];
		if (!kind) return;
		const rawName = nameOf(node);
		if (!rawName) return;
		const name =
			kind === "method" || kind === "property"
				? qualifiedName(node, rawName)
				: rawName;
		const signature =
			kind === "function" || kind === "method"
				? signatureOf(node, name)
				: kind === "interface" || kind === "type"
					? collapse(node.text)
					: undefined;
		addSymbol(symbols, {
			name,
			kind,
			exported: isExported(node),
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			signature,
		});
	});

	return [...symbols.values()].sort(
		(a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name),
	);
}

/** Exports declarados (inclui `export {}` e re-exports). */
function collectExports(root: Node, symbols: readonly AstSymbol[]): AstExport[] {
	const exports = new Map<string, AstExport>();

	for (const symbol of symbols) {
		if (symbol.exported)
			exports.set(symbol.name, { name: symbol.name, kind: symbol.kind });
	}

	walk(root, (node) => {
		if (node.type !== "export_statement") return;
		const before = exports.size;
		const clause = node.descendantsOfType("export_clause")[0];
		if (clause) {
			for (const specifier of clause.descendantsOfType("export_specifier")) {
				const imported = specifier.childForFieldName("name")?.text?.trim();
				const alias = specifier.childForFieldName("alias")?.text?.trim();
				const name = alias ?? imported;
				if (name) exports.set(name, { name, kind: "unknown" });
			}
		}
		const source = node.childForFieldName("source");
		if (source && !clause) {
			exports.set("*", { name: "*", kind: "re-export" });
		}
		if (
			!clause &&
			/^export\s+default\b/.test(node.text.trim()) &&
			exports.size === before
		) {
			exports.set("default", { name: "default", kind: "unknown" });
		}
	});

	return [...exports.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Decorators normalizados (`@Controller` → `Controller`). */
function collectDecorators(root: Node): string[] {
	const decorators = new Set<string>();
	walk(root, (node) => {
		if (node.type !== "decorator") return;
		const match = /^@\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(
			node.text.trim(),
		);
		if (match) decorators.add(match[1]);
	});
	return [...decorators].sort();
}

/** Extrai todos os fatos de uma árvore já parseada. */
export function extractFacts(root: Node, language: AstLanguage): AstFacts {
	const symbols = collectSymbols(root);
	return {
		language,
		symbols,
		imports: collectImports(root),
		exports: collectExports(root, symbols),
		decorators: collectDecorators(root),
		hasSyntaxErrors: root.hasError,
	};
}
