/**
 * Guarda de caminhos das tools — impede leitura fora do repositório e de
 * arquivos sensíveis (`..`, `.git`, `.env*`, binários, arquivos enormes).
 */

import { statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/** Erro de caminho bloqueado (mensagem segura). */
export class PathGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathGuardError";
	}
}

/** Extensões consideradas binárias. */
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".wasm",
	".node",
	".so",
	".dll",
	".exe",
	".lockb",
]);

/** Nomes/diretórios bloqueados. */
function isBlockedPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (/(^|\/)\.git(\/|$)/.test(normalized)) return true;
	if (/(^|\/)node_modules(\/|$)/.test(normalized)) return true;
	if (/(^|\/)\.env(\.|$)/.test(normalized)) return true;
	if (/(^|\/)\.houndsman\/core\/grammars(\/|$)/.test(normalized)) return true;
	return false;
}

/** Guarda de caminhos com raiz fixa. */
export class PathGuard {
	readonly root: string;
	private readonly maxFileBytes: number;

	constructor(root: string, maxFileBytes = 1_000_000) {
		this.root = resolve(root);
		this.maxFileBytes = maxFileBytes;
	}

	/** Resolve um caminho relativo dentro da raiz; lança se escapar. */
	resolvePath(input: string): string {
		if (!input.trim()) throw new PathGuardError("caminho vazio");
		const absolute = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
		const rel = relative(this.root, absolute);
		if (rel.startsWith("..") || rel.split(sep).includes("..")) {
			throw new PathGuardError("caminho fora do repositório");
		}
		if (rel === "") throw new PathGuardError("caminho inválido");
		if (isBlockedPath(rel)) throw new PathGuardError("caminho bloqueado");
		if (BINARY_EXTENSIONS.has(extname(absolute).toLowerCase())) {
			throw new PathGuardError("arquivo binário");
		}
		return absolute;
	}

	/** Resolve e valida tamanho/tipo; devolve o caminho absoluto. */
	assertReadable(input: string): string {
		const absolute = this.resolvePath(input);
		let size = 0;
		try {
			size = statSync(absolute).size;
		} catch {
			throw new PathGuardError("arquivo inexistente");
		}
		if (size > this.maxFileBytes) throw new PathGuardError("arquivo muito grande");
		return absolute;
	}

	/** Caminho relativo normalizado (para respostas). */
	relativePath(input: string): string {
		return relative(this.root, this.resolvePath(input)).replace(/\\/g, "/");
	}
}
