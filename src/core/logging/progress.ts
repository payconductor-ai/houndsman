/**
 * Progresso visual do CLI (infraestrutura).
 *
 * `PhaseReporter` acompanha fases sequenciais (spinner em TTY; `→`/`✔` em
 * pipe). `ProgressBoard` mantém tarefas concorrentes com loader e tempo
 * decorrido — é o que o harness local usa por watchdog.
 *
 * Progresso é diagnóstico: nenhum método lança.
 */

import type { LoggerLike, SpinnerLike } from "./logger";

/** Formata uma duração em ms (`820ms`, `12.3s`, `2m05s`). */
export function formatDuration(ms: number): string {
	const safe = Math.max(0, Math.round(ms));
	if (safe < 1_000) return `${safe}ms`;
	const seconds = safe / 1_000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

/** Relógio curto no formato `m:ss` (usado no loader). */
function clock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1_000));
	const minutes = Math.floor(total / 60);
	return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** Relógio de uma fase: spinner no TTY, linhas `→`/`✔` em pipe. */
export class PhaseReporter {
	private readonly logger: LoggerLike;
	private active: { stage: string; spinner: SpinnerLike } | null = null;

	constructor(logger: LoggerLike) {
		this.logger = logger;
	}

	/** Abre a fase (substituindo qualquer loader anterior). */
	begin(stage: string, message: string): void {
		try {
			this.stop();
			const spinner = this.logger.spinner(message);
			if (spinner) {
				spinner.start();
				this.active = { stage, spinner };
				return;
			}
			this.logger.step(message);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Fecha a fase com a duração medida. */
	end(stage: string, message: string, durationMs: number): void {
		try {
			const text = `${message} (${formatDuration(durationMs)})`;
			if (this.active?.stage === stage) {
				const { spinner } = this.active;
				this.active = null;
				spinner.succeed(text);
				return;
			}
			this.logger.success(text);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Encerra um loader pendente (sem mensagem de sucesso). */
	stop(): void {
		if (!this.active) return;
		const { spinner } = this.active;
		this.active = null;
		try {
			spinner.stop();
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}
}

/**
 * Relógio de fases **concorrentes** (prepare com etapas em paralelo).
 *
 * No TTY mantém um único spinner com a etapa mais recente e a contagem das
 * demais; em pipe preserva o formato `→`/`✔` por etapa do `PhaseReporter`.
 */
export class ParallelPhaseReporter {
	private readonly logger: LoggerLike;
	private readonly active = new Map<string, string>();
	private spinner: SpinnerLike | null = null;

	constructor(logger: LoggerLike) {
		this.logger = logger;
	}

	/** Abre uma fase (pode haver várias ativas ao mesmo tempo). */
	begin(stage: string, message: string): void {
		try {
			this.active.set(stage, message);
			if (this.spinner) {
				this.restart();
				return;
			}
			const spinner = this.logger.spinner(this.summary());
			if (spinner) {
				this.spinner = spinner.start();
				return;
			}
			this.logger.step(message);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Fecha uma fase com a duração medida. */
	end(stage: string, message: string, durationMs: number): void {
		try {
			this.active.delete(stage);
			const text = `${message} (${formatDuration(durationMs)})`;
			if (this.spinner) {
				this.spinner.stop();
				this.spinner = null;
				this.logger.success(text);
				this.startSpinner();
				return;
			}
			this.logger.success(text);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Encerra o spinner pendente (sem mensagem de sucesso). */
	stop(): void {
		try {
			this.spinner?.stop();
		} catch {
			// Progresso nunca derruba a revisão.
		}
		this.spinner = null;
	}

	/** Texto agregado das fases ativas. */
	private summary(): string {
		const messages = [...this.active.values()];
		if (messages.length <= 1) return messages[0] ?? "";
		return `${messages[0]} (+${messages.length - 1} em paralelo)`;
	}

	/** Reinicia o spinner com o texto agregado atualizado. */
	private restart(): void {
		if (!this.spinner) return;
		this.spinner.stop();
		this.spinner = null;
		this.startSpinner();
	}

	/** (Re)abre o spinner quando ainda há fases ativas. */
	private startSpinner(): void {
		if (this.active.size === 0) return;
		const spinner = this.logger.spinner(this.summary());
		this.spinner = spinner ? spinner.start() : null;
	}
}

/** Tarefa concorrente exibida pelo board. */
type BoardTask = {
	id: string;
	detail: string;
	startedMs: number;
};
export type ProgressBoardOptions = {
	logger: LoggerLike;
	/** Intervalo de repintura do loader em TTY (ms). */
	frameMs?: number;
	/** Intervalo do heartbeat textual fora de TTY (ms). */
	heartbeatMs?: number;
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Board de tarefas concorrentes (watchdogs do `hunt`).
 *
 * Em TTY repinta um bloco com loader + tempo decorrido por tarefa. Fora de
 * TTY mantém as linhas de início/fim e emite um heartbeat periódico com quem
 * ainda está rodando — o log do CI continua mostrando progresso.
 */
export class ProgressBoard {
	private readonly logger: LoggerLike;
	private readonly frameMs: number;
	private readonly heartbeatMs: number;
	private readonly tasks = new Map<string, BoardTask>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private rendered = 0;
	private frame = 0;
	private done = 0;
	private failed = 0;
	private total = 0;
	private lastHeartbeat = Date.now();

	constructor(options: ProgressBoardOptions) {
		this.logger = options.logger;
		this.frameMs = options.frameMs ?? 200;
		this.heartbeatMs = options.heartbeatMs ?? 30_000;
	}

	/** Define o total de tarefas do lote (rodapé do bloco). */
	start(total: number): void {
		this.total = Math.max(0, total);
	}

	/** Registra uma tarefa em execução. */
	add(id: string, detail = "em execução"): void {
		try {
			this.tasks.set(id, { id, detail, startedMs: Date.now() });
			if (!this.logger.interactive) this.logger.bullet(`${id}: ${detail}…`);
			this.ensureTimer();
			this.paint();
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Atualiza o detalhe de uma tarefa (ex.: tentativa atual). */
	update(id: string, detail: string): void {
		const task = this.tasks.get(id);
		if (!task) return;
		task.detail = detail;
		this.paint();
	}

	/** Atualiza o detalhe e avisa em pipe (tentativas/retries). */
	retry(id: string, detail: string, message: string): void {
		try {
			this.update(id, detail);
			if (!this.logger.interactive) this.logger.bullet(message);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Conclui uma tarefa com a mensagem final. */
	succeed(id: string, message: string): void {
		try {
			if (this.tasks.delete(id)) this.done++;
			if (!this.logger.interactive) {
				this.logger.success(message);
				return;
			}
			this.clear();
			this.logger.success(message);
			this.paint();
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Falha uma tarefa com a mensagem final. */
	fail(id: string, message: string): void {
		try {
			if (this.tasks.delete(id)) this.failed++;
			if (!this.logger.interactive) {
				this.logger.warn(message);
				return;
			}
			this.clear();
			this.logger.warn(message);
			this.paint();
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Encerra o board (timer + bloco renderizado). */
	stop(): void {
		this.stopTimer();
		this.clear();
	}

	private ensureTimer(): void {
		if (this.timer) return;
		const period = this.logger.interactive ? this.frameMs : this.heartbeatMs;
		this.timer = setInterval(() => this.tick(), period);
		// Nunca segura o processo vivo por causa de um loader.
		(this.timer as unknown as { unref?: () => void }).unref?.();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private tick(): void {
		if (this.tasks.size === 0) {
			this.stopTimer();
			return;
		}
		if (this.logger.interactive) {
			this.frame++;
			this.paint();
			return;
		}
		if (Date.now() - this.lastHeartbeat < this.heartbeatMs) return;
		this.lastHeartbeat = Date.now();
		try {
			const running = [...this.tasks.values()]
				.map((task) => `${task.id} (${clock(Date.now() - task.startedMs)})`)
				.join(", ");
			this.logger.bullet(`${this.tasks.size} tarefa(s) em execução: ${running}`);
		} catch {
			// Progresso nunca derruba a revisão.
		}
	}

	/** Linhas do bloco (ativas + rodapé). */
	private lines(): string[] {
		const now = Date.now();
		const active = [...this.tasks.values()];
		const width = Math.max(...active.map((task) => task.id.length), 0);
		const spinner = FRAMES[this.frame % FRAMES.length];
		const rows = active.map(
			(task) =>
				`  ${spinner} ${task.id.padEnd(width)}  ${task.detail} · ${clock(now - task.startedMs)}`,
		);
		const finished = this.done + this.failed;
		const failures = this.failed > 0 ? ` · ${this.failed} falha(s)` : "";
		rows.push(
			`  ${finished}/${this.total} concluído(s)${failures} · ${active.length} em execução`,
		);
		return rows;
	}

	/** Repinta o bloco no lugar (movendo o cursor para cima). */
	private paint(): void {
		if (!this.logger.interactive) return;
		const lines = this.lines();
		const stream = this.logger.stream;
		const total = Math.max(this.rendered, lines.length);
		if (this.rendered > 0) stream.write(`\u001b[${this.rendered}A`);
		for (let index = 0; index < total; index++) {
			stream.write(`\u001b[2K${lines[index] ?? ""}\n`);
		}
		const extra = total - lines.length;
		if (extra > 0) stream.write(`\u001b[${extra}A`);
		this.rendered = lines.length;
	}

	/** Apaga o bloco renderizado (deixa o cursor no início dele). */
	private clear(): void {
		if (!this.logger.interactive || this.rendered === 0) return;
		const stream = this.logger.stream;
		stream.write(`\u001b[${this.rendered}A`);
		for (let index = 0; index < this.rendered; index++) {
			stream.write("\u001b[2K\n");
		}
		stream.write(`\u001b[${this.rendered}A`);
		this.rendered = 0;
	}
}
