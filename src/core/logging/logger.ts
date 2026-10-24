/**
 * Logger único do CLI (infraestrutura).
 *
 * Usa `chalk` para cor e `ora` para spinner, mas cai para texto puro quando a
 * saída não é TTY, `NO_COLOR` está definido, `TERM=dumb` ou `--quiet`.
 *
 * Não é usado por módulos de negócio do `core/`: só `cli/` e `server/`
 * escrevem saída.
 */

import { Chalk, type ChalkInstance } from "chalk";
import ora, { type Ora } from "ora";
import { env } from "../env";

/** Spinner mínimo (compatível com `ora` e com o modo silencioso). */
export type SpinnerLike = {
	start(): SpinnerLike;
	stop(): void;
	succeed(text?: string): void;
	fail(text?: string): void;
	warn(text?: string): void;
	readonly text: string;
};

/** Superfície de log usada por comandos e reporter. */
export interface LoggerLike {
	debug(message: string): void;
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	step(message: string): void;
	bullet(message: string): void;
	table(rows: readonly (readonly string[])[]): void;
	progress(message: string): void;
	spinner(text: string): SpinnerLike | null;
	withSpinner<T>(
		text: string,
		run: (spinner: SpinnerLike | null) => Promise<T>,
	): Promise<T>;
	/** `true` quando a saída é um TTY e o modo quiet está desligado. */
	readonly interactive: boolean;
	/** Stream de saída (usado pelos blocos de progresso). */
	readonly stream: NodeJS.WritableStream;
}

/** Opções do logger (injetáveis nos testes). */
export type LoggerOptions = {
	/** `auto` (default), `true` (força cor) ou `false` (plain). */
	color?: boolean | "auto";
	quiet?: boolean;
	verbose?: boolean;
	stdout?: NodeJS.WritableStream;
	stderr?: NodeJS.WritableStream;
	/** Sobrescreve a detecção de TTY (testes). */
	isTTY?: boolean;
};

/** `true` quando cores devem ser desabilitadas pelo ambiente. */
function colorsDisabled(): boolean {
	return Boolean(env.noColor) || env.term === "dumb";
}

/** Cria a instância de chalk respeitando as opções. */
function createChalk(color: LoggerOptions["color"]): ChalkInstance {
	if (color === false || colorsDisabled()) return new Chalk({ level: 0 });
	if (color === true) return new Chalk({ level: 1 });
	return new Chalk();
}

/** Logger com saída injetável. */
export class Logger implements LoggerLike {
	private readonly out: NodeJS.WritableStream;
	private readonly err: NodeJS.WritableStream;
	private readonly chalk: ChalkInstance;
	private readonly quiet: boolean;
	private readonly verbose: boolean;
	private readonly tty: boolean;

	constructor(options: LoggerOptions = {}) {
		this.out = options.stdout ?? process.stdout;
		this.err = options.stderr ?? process.stderr;
		this.chalk = createChalk(options.color ?? "auto");
		this.quiet = options.quiet === true;
		this.verbose = options.verbose === true;
		this.tty = options.isTTY ?? Boolean(process.stdout.isTTY);
	}

	/** Loader/blocos só fazem sentido em terminal interativo. */
	get interactive(): boolean {
		return this.tty && !this.quiet;
	}

	/** Stream dos blocos de progresso. */
	get stream(): NodeJS.WritableStream {
		return this.out;
	}

	/** Só aparece em `--verbose`. */
	debug(message: string): void {
		if (!this.verbose || this.quiet) return;
		this.out.write(`${this.chalk.dim(`[debug] ${message}`)}\n`);
	}

	info(message: string): void {
		if (this.quiet) return;
		this.out.write(`${message}\n`);
	}

	success(message: string): void {
		if (this.quiet) return;
		this.out.write(`${this.chalk.green("✔")} ${message}\n`);
	}

	warn(message: string): void {
		if (this.quiet) return;
		this.err.write(`${this.chalk.yellow("⚠")} ${message}\n`);
	}

	error(message: string): void {
		this.err.write(`${this.chalk.red("✖")} ${message}\n`);
	}

	step(message: string): void {
		if (this.quiet) return;
		this.out.write(`${this.chalk.cyan("→")} ${message}\n`);
	}

	bullet(message: string): void {
		if (this.quiet) return;
		this.out.write(`  ${this.chalk.dim("•")} ${message}\n`);
	}

	/** Tabela simples com colunas alinhadas (sem ANSI nos valores). */
	table(rows: readonly (readonly string[])[]): void {
		if (this.quiet || rows.length === 0) return;
		const width = Math.max(...rows.map((row) => row.length));
		const sizes = Array.from({ length: width }, (_, column) =>
			Math.max(...rows.map((row) => (row[column] ?? "").length)),
		);
		rows.forEach((row, index) => {
			const line = row
				.map((cell, column) => (cell ?? "").padEnd(sizes[column] ?? 0))
				.join("  ")
				.trimEnd();
			this.out.write(`${index === 0 ? this.chalk.bold(line) : line}\n`);
		});
	}

	/** Progresso textual (usado pelo `AgentReporter`). */
	progress(message: string): void {
		this.info(message);
	}

	/** Spinner habilitado apenas em TTY e fora do modo quiet. */
	spinner(text: string): SpinnerLike | null {
		if (!this.tty || this.quiet) return null;
		return ora({ text, stream: this.out as NodeJS.WriteStream, isEnabled: true });
	}

	/** Executa `run` com um spinner opcional; sempre para o spinner. */
	async withSpinner<T>(
		text: string,
		run: (spinner: SpinnerLike | null) => Promise<T>,
	): Promise<T> {
		const spinner = this.spinner(text);
		spinner?.start();
		try {
			const result = await run(spinner);
			spinner?.succeed();
			return result;
		} catch (error) {
			spinner?.fail();
			throw error;
		}
	}
}

/** Logger silencioso para testes/serviços. */
export class SilentLogger implements LoggerLike {
	readonly interactive = false;
	readonly stream: NodeJS.WritableStream = {
		write: () => true,
	} as unknown as NodeJS.WritableStream;

	debug(_message?: string): void {}
	info(_message?: string): void {}
	success(_message?: string): void {}
	warn(_message?: string): void {}
	error(_message?: string): void {}
	step(_message?: string): void {}
	bullet(_message?: string): void {}
	table(_rows?: readonly (readonly string[])[]): void {}
	progress(_message?: string): void {}
	spinner(_text?: string): SpinnerLike | null {
		return null;
	}
	async withSpinner<T>(
		_text: string,
		run: (spinner: SpinnerLike | null) => Promise<T>,
	): Promise<T> {
		return run(null);
	}
}

export type { Ora };
