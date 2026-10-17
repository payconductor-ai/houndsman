/**
 * Registry de comandos (CLI) — resolve nome → comando e guarda o fallback.
 */

import type { Command } from "./command";

/** Mapa de comandos por nome, com um comando default. */
export class CommandRegistry {
	private readonly commands = new Map<string, Command>();
	private fallback: Command | undefined;

	/** Registra um comando (ou o fallback, quando `fallback`). */
	register(command: Command, options: { fallback?: boolean } = {}): this {
		if (options.fallback) this.fallback = command;
		else this.commands.set(command.name, command);
		return this;
	}

	/** Registra o mesmo comando sob outro nome (alias). */
	registerAs(name: string, command: Command): this {
		this.commands.set(name, command);
		return this;
	}

	/** Resolve o comando pelo nome; sem nome → fallback. */
	resolve(name: string | undefined): Command | undefined {
		return name ? this.commands.get(name) : this.fallback;
	}

	/** Nomes registrados (sem o fallback). */
	names(): string[] {
		return [...this.commands.keys()];
	}
}
