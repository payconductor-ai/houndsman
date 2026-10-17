/**
 * Parser tree-sitter (biblioteca).
 *
 * Inicialização lazy e por linguagem: o wasm só é carregado quando existe um
 * arquivo compatível. Qualquer falha (grammar ausente, ABI incompatível, arquivo
 * grande/binário) devolve `null` — o chamador segue sem AST.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { grammarPath } from "../assets";
import { DEFAULT_AST_MAX_FILE_BYTES } from "../defaults";
import { extractFacts } from "./symbols";
import type { AstFacts, AstLanguage } from "./types";

/** Arquivo wasm de cada linguagem suportada. */
const GRAMMAR_BY_LANGUAGE: Record<AstLanguage, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
};

/** Extensões reconhecidas por padrão (override via config). */
const DEFAULT_LANGUAGE_BY_EXTENSION: Record<string, AstLanguage> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".jsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
};

/** Teto default de bytes por arquivo (evita parsear bundles/minificados). */
export const DEFAULT_MAX_FILE_BYTES = DEFAULT_AST_MAX_FILE_BYTES;

/** Opções do parser. */
export type AstParserOptions = {
	maxFileBytes?: number;
	/** Override de extensão → linguagem (chave com ou sem ponto). */
	languages?: Record<string, AstLanguage>;
	/** Diretório com grammars locais (`.houndsman/core/grammars`) — tem precedência. */
	grammarDir?: string;
};

/** Normaliza a chave de extensão (`ts`/`.ts` → `.ts`). */
function normalizeExtension(key: string): string {
	const trimmed = key.trim().toLowerCase();
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Resolve a linguagem de um arquivo pela extensão. `null` quando não suportado.
 */
export function languageForPath(
	filePath: string,
	overrides: Record<string, AstLanguage> = {},
): AstLanguage | null {
	const extension = extname(filePath).toLowerCase();
	if (!extension) return null;
	const normalized = Object.fromEntries(
		Object.entries(overrides).map(([key, value]) => [normalizeExtension(key), value]),
	);
	return normalized[extension] ?? DEFAULT_LANGUAGE_BY_EXTENSION[extension] ?? null;
}

/** Parser lazy, com uma instância por linguagem. */
export class AstParser {
	private initPromise: Promise<void> | null = null;
	private readonly languages = new Map<AstLanguage, Language>();
	private readonly parsers = new Map<AstLanguage, Parser>();
	private readonly options: Required<Pick<AstParserOptions, "maxFileBytes">> &
		AstParserOptions;

	constructor(options: AstParserOptions = {}) {
		this.options = {
			maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
			languages: options.languages,
			grammarDir: options.grammarDir,
		};
	}

	/** Resolve uma grammar: camada do projeto primeiro, pacote como fallback. */
	private grammarFile(name: string): string {
		if (this.options.grammarDir) {
			const local = join(this.options.grammarDir, name);
			if (existsSync(local)) return local;
		}
		return grammarPath(name);
	}

	/** Inicializa o runtime wasm (idempotente). */
	async init(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = Parser.init({
				locateFile: (name: string) => this.grammarFile(name),
			});
		}
		await this.initPromise;
	}

	/** Parser configurado para a linguagem (carrega a grammar sob demanda). */
	private async parserFor(language: AstLanguage): Promise<Parser> {
		const existing = this.parsers.get(language);
		if (existing) return existing;

		await this.init();
		const loaded = await Language.load(
			this.grammarFile(GRAMMAR_BY_LANGUAGE[language]),
		);
		const parser = new Parser();
		parser.setLanguage(loaded);
		this.languages.set(language, loaded);
		this.parsers.set(language, parser);
		return parser;
	}

	/** Parseia um texto e devolve os fatos; `null` se a linguagem falhar. */
	async parseSource(language: AstLanguage, source: string): Promise<AstFacts | null> {
		try {
			const parser = await this.parserFor(language);
			const tree = parser.parse(source);
			if (!tree) return null;
			try {
				return extractFacts(tree.rootNode, language);
			} finally {
				tree.delete();
			}
		} catch {
			return null;
		}
	}

	/**
	 * Parseia um arquivo do working tree. `source` permite reaproveitar conteúdo
	 * já lido; sem ele, o arquivo é lido do disco.
	 */
	async parseFile(filePath: string, source?: string): Promise<AstFacts | null> {
		const language = languageForPath(filePath, this.options.languages);
		if (!language) return null;

		let content = source;
		if (content === undefined) {
			try {
				const size = statSync(filePath).size;
				if (size <= 0 || size > this.options.maxFileBytes) return null;
				content = readFileSync(filePath, "utf8");
			} catch {
				return null;
			}
		}
		if (content.length > this.options.maxFileBytes || content.includes("\0")) {
			return null;
		}
		return this.parseSource(language, content);
	}

	/** Libera parsers/grammars (usado em testes). */
	dispose(): void {
		for (const parser of this.parsers.values()) parser.delete();
		this.parsers.clear();
		this.languages.clear();
		this.initPromise = null;
	}
}
