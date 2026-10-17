/**
 * Acesso a arquivos do projeto (biblioteca) — I/O centralizado e injetável.
 *
 * Caminhos relativos são resolvidos contra o `cwd` do projeto; absolutos passam
 * intactos. Operações que falham devolvem `null`/`false` em vez de lançar, para
 * manter o comportamento fail-open do motor.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Leitor de arquivos relativos à raiz do projeto (injetável nos testes). */
export type FileReader = (relativePath: string) => string | null;

/** Acesso ao filesystem resolvido a partir de um `cwd`. */
export class ProjectFiles {
	private readonly cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	/** Resolve um caminho (relativo → absoluto). */
	resolve(path: string): string {
		return isAbsolute(path) ? path : join(this.cwd, path);
	}

	/** Lê UTF-8; `null` se ausente/ilegível. */
	read(path: string): string | null {
		const full = this.resolve(path);
		try {
			return existsSync(full) ? readFileSync(full, "utf8") : null;
		} catch {
			return null;
		}
	}

	/** Lê + parseia JSON; `null` se ausente/inválido. */
	readJson<T>(path: string): T | null {
		const raw = this.read(path);
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	/** Escreve UTF-8, criando o diretório pai. */
	write(path: string, content: string): void {
		const full = this.resolve(path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}

	/** Escrita atômica (tmp + rename). */
	writeAtomic(path: string, content: string): void {
		const full = this.resolve(path);
		mkdirSync(dirname(full), { recursive: true });
		const tmp = `${full}.${process.pid}.tmp`;
		writeFileSync(tmp, content);
		renameSync(tmp, full);
	}

	/** Cria o diretório (recursivo). */
	ensureDir(path: string): void {
		mkdirSync(this.resolve(path), { recursive: true });
	}

	/** Remove um diretório (recursivo, best-effort). */
	removeDir(path: string): void {
		rmSync(this.resolve(path), { recursive: true, force: true });
	}

	/** `true` se o caminho existe. */
	exists(path: string): boolean {
		return existsSync(this.resolve(path));
	}

	/** Função de leitura ligada a este `cwd` (compatível com `FileReader`). */
	reader(): FileReader {
		return (relativePath: string) => this.read(relativePath);
	}
}
