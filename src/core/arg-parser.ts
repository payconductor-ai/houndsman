/**
 * Parser simples de argv (biblioteca) — compartilhado por CLI e comandos.
 *
 * Não valida flags: só lê valores/booleanos e separa o subcomando.
 */

/** argv com leitura de flags por nome. */
export class ArgParser {
	readonly argv: string[];

	constructor(argv: readonly string[]) {
		this.argv = [...argv];
	}

	static from(argv: readonly string[]): ArgParser {
		return new ArgParser(argv);
	}

	/** Valor da flag (`--x y`), se presente. */
	value(flag: string): string | undefined {
		const index = this.argv.indexOf(flag);
		return index >= 0 ? this.argv[index + 1] : undefined;
	}

	/** `true` se a flag está presente. */
	has(flag: string): boolean {
		return this.argv.includes(flag);
	}

	/** Primeiro token que não é flag (subcomando). */
	command(): string | undefined {
		const first = this.argv[0];
		return first && !first.startsWith("-") ? first : undefined;
	}

	/** Argumentos sem o subcomando. */
	rest(): string[] {
		const command = this.command();
		if (!command) return this.argv;
		const index = this.argv.indexOf(command);
		return [...this.argv.slice(0, index), ...this.argv.slice(index + 1)];
	}

	/** Todos os tokens que não começam com `-`. */
	positionals(): string[] {
		return this.argv.filter((arg) => !arg.startsWith("-"));
	}
}
