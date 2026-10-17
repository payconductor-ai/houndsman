/**
 * Tipos do subsistema AST (biblioteca).
 *
 * O AST é uma camada determinística de enriquecimento: fatos estruturais por
 * arquivo, delta entre duas versões e impacto (importadores). Nunca substitui a
 * classificação por regex — apenas a complementa quando a grammar está
 * disponível.
 */

/** Linguagens suportadas na primeira fase (TS/JS). */
export type AstLanguage = "typescript" | "tsx" | "javascript";

/** Espécie de símbolo extraído do arquivo. */
export type AstSymbolKind =
	| "function"
	| "class"
	| "method"
	| "interface"
	| "type"
	| "enum"
	| "variable"
	| "property"
	| "unknown";

/** Símbolo declarado no arquivo (nome, espécie, intervalo e assinatura). */
export type AstSymbol = {
	name: string;
	kind: AstSymbolKind;
	/** `true` quando a declaração está sob um `export_statement`. */
	exported: boolean;
	/** Linha inicial (1-based). */
	startLine: number;
	/** Linha final (1-based). */
	endLine: number;
	/** Assinatura normalizada (parâmetros/retorno), quando aplicável. */
	signature?: string;
};

/** Import declarado no arquivo. */
export type AstImport = {
	source: string;
	/** Nomes importados/locais (útil para classificação por símbolo). */
	names: string[];
	/** `import type` / `export type`. */
	typeOnly: boolean;
};

/** Export declarado no arquivo (inclui re-exports). */
export type AstExport = {
	name: string;
	kind: AstSymbolKind | "re-export";
};

/** Fatos estruturais de um arquivo. */
export type AstFacts = {
	language: AstLanguage;
	symbols: AstSymbol[];
	imports: AstImport[];
	exports: AstExport[];
	decorators: string[];
	/** `true` quando o parser encontrou erro de sintaxe. */
	hasSyntaxErrors: boolean;
};

/** Mudança de assinatura de um símbolo entre duas versões. */
export type AstSignatureChange = {
	name: string;
	before: string;
	after: string;
	exported: boolean;
};

/** Mudança de export (nome adicionado/removido). */
export type AstExportChange = {
	name: string;
	change: "added" | "removed";
};

/** Delta estrutural entre a versão base e a versão atual. */
export type AstDelta = {
	addedSymbols: AstSymbol[];
	removedSymbols: AstSymbol[];
	modifiedSymbols: AstSymbol[];
	changedSignatures: AstSignatureChange[];
	addedImports: string[];
	removedImports: string[];
	changedExports: AstExportChange[];
};

/** Análise de um arquivo alterado: fatos atuais + delta. */
export type AstAnalysis = {
	facts: AstFacts;
	delta?: AstDelta;
	/** `true` quando o arquivo foi removido (fatos são da versão base). */
	deleted?: boolean;
};

/** Impacto estrutural de um conjunto de alterações. */
export type AstImpact = {
	/** arquivo alterado → arquivos que o importam (reverse deps). */
	importers: Record<string, string[]>;
	/** União ordenada dos importadores. */
	affectedFiles: string[];
	/** Exports públicos removidos/alterados (candidatos a breaking change). */
	exportedChanges: {
		file: string;
		symbol: string;
		change: "removed" | "signature";
	}[];
};

/** Resumo de AST injetado no brief de um watchdog. */
export type AstFileBrief = {
	file: string;
	delta: AstDelta;
	/** Arquivos que importam este arquivo (impacto reverso). */
	importers?: readonly string[];
};

/** Entrada mínima para analisar um arquivo alterado. */
export type AstEntry = {
	path: string;
	oldPath?: string;
	status: string;
};
