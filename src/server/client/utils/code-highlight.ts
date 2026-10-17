/**
 * Destaque de sintaxe de código (cliente) — implementação própria e leve.
 *
 * A linguagem é inferida pela extensão do arquivo do finding. Para extensões
 * conhecidas destacamos strings, comentários, números, keywords, tipos,
 * funções e propriedades; para as demais, o evidence continua texto puro.
 */

import { highlightJson } from "./json-highlight";

export type CodeTokenType =
	| "plain"
	| "keyword"
	| "string"
	| "comment"
	| "number"
	| "type"
	| "function"
	| "property"
	| "punct";

export type CodeToken = { text: string; type: CodeTokenType };

export type HighlightedCode = {
	language: string;
	label: string;
	tokens: CodeToken[];
};

type LanguageConfig = {
	label: string;
	keywords: ReadonlySet<string>;
	types?: ReadonlySet<string>;
	lineComments: readonly string[];
	blockComments: readonly (readonly [string, string])[];
	/** Templates strings com backtick (JS/TS/Go). */
	backtick?: boolean;
	/** Strings de três aspas (Python). */
	tripleQuotes?: boolean;
	/** `chave:` no início da linha vira propriedade (YAML). */
	keyColon?: boolean;
	/** Identificador seguido de `:` vira propriedade (CSS). */
	cssProperty?: boolean;
	/** Rastreia tags/atributos (HTML/XML). */
	html?: boolean;
};

function words(value: string): ReadonlySet<string> {
	return new Set(value.split(/\s+/).filter(Boolean));
}

const JS_KEYWORDS = words(
	"as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
);

const CONFIG: Record<string, LanguageConfig> = {
	typescript: {
		label: "TypeScript",
		keywords: JS_KEYWORDS,
		types: words("any bigint boolean never number object string symbol unknown"),
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
		backtick: true,
	},
	javascript: {
		label: "JavaScript",
		keywords: JS_KEYWORDS,
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
		backtick: true,
	},
	python: {
		label: "Python",
		keywords: words(
			"and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
		),
		lineComments: ["#"],
		blockComments: [],
		tripleQuotes: true,
	},
	go: {
		label: "Go",
		keywords: words(
			"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
		),
		types: words(
			"bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
		),
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
		backtick: true,
	},
	rust: {
		label: "Rust",
		keywords: words(
			"as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
		),
		types: words(
			"bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize",
		),
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
	},
	java: {
		label: "Java",
		keywords: words(
			"abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient true false try var void volatile while",
		),
		types: words("boolean byte char double float int long short String void"),
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
	},
	csharp: {
		label: "C#",
		keywords: words(
			"abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while",
		),
		types: words(
			"bool byte char decimal double float int long object sbyte short string uint ulong ushort void",
		),
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
	},
	php: {
		label: "PHP",
		keywords: words(
			"abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true false try unset use var while xor yield",
		),
		lineComments: ["//", "#"],
		blockComments: [["/*", "*/"]],
	},
	ruby: {
		label: "Ruby",
		keywords: words(
			"alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
		),
		lineComments: ["#"],
		blockComments: [],
	},
	bash: {
		label: "Shell",
		keywords: words(
			"if then else elif fi for in do done while until case esac function select time local export readonly return break continue true false",
		),
		lineComments: ["#"],
		blockComments: [],
	},
	sql: {
		label: "SQL",
		keywords: words(
			"select from where join inner left right full outer on group by order having limit offset insert into values update set delete create table alter drop index view as and or not null is in like between exists case when then else end distinct union all count sum avg min max returning with asc desc",
		),
		lineComments: ["--"],
		blockComments: [["/*", "*/"]],
	},
	yaml: {
		label: "YAML",
		keywords: words("true false null yes no on off"),
		lineComments: ["#"],
		blockComments: [],
		keyColon: true,
	},
	css: {
		label: "CSS",
		keywords: words(
			"important media import supports keyframes font-face from to and or not only",
		),
		lineComments: [],
		blockComments: [["/*", "*/"]],
		cssProperty: true,
	},
	html: {
		label: "HTML",
		keywords: new Set(),
		lineComments: [],
		blockComments: [["<!--", "-->"]],
		html: true,
	},
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	cs: "csharp",
	php: "php",
	rb: "ruby",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	yml: "yaml",
	yaml: "yaml",
	css: "css",
	scss: "css",
	html: "html",
	htm: "html",
	xml: "html",
};

/** Linguagem a partir da extensão do arquivo (null = sem highlight). */
export function languageFromFile(file: string): string | null {
	const base = file.split(/[\\/]/).pop() ?? file;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return null;
	return EXTENSION_TO_LANGUAGE[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Linguagem a partir do nome/alias usado em fences markdown (`ts`, `py`…). */
export function languageFromName(name: string | null | undefined): string | null {
	if (!name) return null;
	const key = name.trim().toLowerCase();
	const alias: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		py: "python",
		rs: "rust",
		cs: "csharp",
		"c#": "csharp",
		rb: "ruby",
		sh: "bash",
		shell: "bash",
		yml: "yaml",
		scss: "css",
		xml: "html",
	};
	const language = alias[key] ?? key;
	return language === "json" || CONFIG[language] ? language : null;
}

/** Destaca o código; null quando a linguagem é desconhecida/ausente. */
export function highlightCode(
	code: string,
	language: string | null,
): HighlightedCode | null {
	if (!language) return null;
	if (language === "json") {
		return {
			language,
			label: "JSON",
			tokens: highlightJson(code).map((token) => ({
				text: token.text,
				type:
					token.type === "key"
						? "property"
						: token.type === "literal"
							? "keyword"
							: token.type,
			})),
		};
	}
	const config = CONFIG[language];
	if (!config) return null;
	return {
		language,
		label: config.label,
		tokens: tokenize(code, config),
	};
}

// ---------------------------------------------------------------------------
// Tokenização
// ---------------------------------------------------------------------------

function matchComment(rest: string, config: LanguageConfig): string | null {
	for (const [start, end] of config.blockComments) {
		if (!rest.startsWith(start)) continue;
		const close = rest.indexOf(end, start.length);
		return close < 0 ? rest : rest.slice(0, close + end.length);
	}
	for (const marker of config.lineComments) {
		if (!rest.startsWith(marker)) continue;
		const newline = rest.indexOf("\n");
		return newline < 0 ? rest : rest.slice(0, newline);
	}
	return null;
}

function previousNonSpace(code: string, index: number): string {
	for (let i = index - 1; i >= 0; i--) {
		if (!/\s/.test(code[i])) return code[i];
	}
	return "";
}

function nextNonSpace(code: string, index: number): string {
	for (let i = index; i < code.length; i++) {
		if (!/\s/.test(code[i])) return code[i];
	}
	return "";
}

function atLineStart(code: string, index: number): boolean {
	const lineStart = code.lastIndexOf("\n", index - 1) + 1;
	return /^\s*$/.test(code.slice(lineStart, index));
}

function tokenize(code: string, config: LanguageConfig): CodeToken[] {
	const tokens: CodeToken[] = [];
	let index = 0;
	let inTag = false;
	const push = (text: string, type: CodeTokenType): void => {
		if (text.length > 0) tokens.push({ text, type });
	};

	while (index < code.length) {
		const rest = code.slice(index);

		const comment = matchComment(rest, config);
		if (comment !== null) {
			push(comment, "comment");
			index += comment.length;
			continue;
		}

		if (config.tripleQuotes && (rest.startsWith('"""') || rest.startsWith("'''"))) {
			const quote = rest.slice(0, 3);
			const close = code.indexOf(quote, index + 3);
			const end = close < 0 ? code.length : close + 3;
			push(code.slice(index, end), "string");
			index = end;
			continue;
		}

		const char = code[index];
		if (char === '"' || char === "'" || (char === "`" && config.backtick)) {
			let end = index + 1;
			while (end < code.length) {
				if (code[end] === "\\" && char !== "`") {
					end += 2;
					continue;
				}
				if (code[end] === char) {
					end++;
					break;
				}
				end++;
			}
			push(code.slice(index, end), "string");
			index = end;
			continue;
		}

		const number = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
		if (number) {
			push(number[0], "number");
			index += number[0].length;
			continue;
		}

		const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
		if (identifier) {
			const word = identifier[0];
			const previous = previousNonSpace(code, index);
			const next = nextNonSpace(code, index + word.length);
			let type: CodeTokenType = "plain";
			if (config.keywords.has(word)) {
				type = "keyword";
			} else if (config.types?.has(word)) {
				type = "type";
			} else if (next === "(") {
				type = "function";
			} else if (config.html && inTag) {
				type =
					previous === "<" || (previous === "/" && code[index - 2] === "<")
						? "keyword"
						: "property";
			} else if (config.keyColon && next === ":" && atLineStart(code, index)) {
				type = "property";
			} else if (config.cssProperty && next === ":") {
				type = "property";
			} else if (previous === ".") {
				type = "property";
			} else if (/^[A-Z]/.test(word)) {
				type = "type";
			}
			push(word, type);
			index += word.length;
			continue;
		}

		if (char === "<") {
			push(char, "punct");
			inTag = config.html ? true : inTag;
			index++;
			continue;
		}
		if (char === ">" && inTag) {
			push(char, "punct");
			inTag = false;
			index++;
			continue;
		}
		if (/[{}()[\];,.:=+\-*/%<>!&|?~^@]/.test(char)) {
			push(char, "punct");
			index++;
			continue;
		}
		if (/\s/.test(char)) {
			const whitespace = /^\s+/.exec(rest);
			const text = whitespace?.[0] ?? char;
			push(text, "plain");
			index += text.length;
			continue;
		}
		push(char, "plain");
		index++;
	}
	return tokens;
}
