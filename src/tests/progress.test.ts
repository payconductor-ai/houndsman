/**
 * Progresso do CLI — formatação, fases sequenciais e board concorrente.
 *
 * O board em TTY pinta um bloco com loader; fora de TTY mantém as linhas de
 * início/fim e um heartbeat periódico.
 */

import { describe, expect, test } from "bun:test";
import { formatDuration, Logger, PhaseReporter, ProgressBoard } from "../core/logging";

function memoryStream(): { stream: NodeJS.WritableStream; text: () => string } {
	let content = "";
	const stream = {
		write(chunk: string) {
			content += chunk;
			return true;
		},
		isTTY: false,
	} as unknown as NodeJS.WritableStream;
	return { stream, text: () => content };
}

function loggerFor(tty: boolean): {
	logger: Logger;
	out: ReturnType<typeof memoryStream>;
	err: ReturnType<typeof memoryStream>;
} {
	const out = memoryStream();
	const err = memoryStream();
	const logger = new Logger({
		stdout: out.stream,
		stderr: err.stream,
		color: false,
		isTTY: tty,
	});
	return { logger, out, err };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("formatDuration", () => {
	test("ms, segundos e minutos", () => {
		expect(formatDuration(820)).toBe("820ms");
		expect(formatDuration(3_400)).toBe("3.4s");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(125_000)).toBe("2m05s");
	});
});

describe("PhaseReporter", () => {
	test("em pipe imprime início e fim com a duração", () => {
		const { logger, out } = loggerFor(false);
		const reporter = new PhaseReporter(logger);
		reporter.begin("diff", "Lendo o diff");
		expect(out.text()).toContain("→ Lendo o diff");
		reporter.end("diff", "Diff lido", 1_200);
		expect(out.text()).toContain("✔ Diff lido (1.2s)");
	});

	test("fase sem início ainda reporta o fim", () => {
		const { logger, out } = loggerFor(false);
		new PhaseReporter(logger).end("ast", "AST analisada", 40);
		expect(out.text()).toContain("AST analisada (40ms)");
	});
});

describe("ProgressBoard", () => {
	test("em pipe loga início/fim e não usa ANSI", () => {
		const { logger, out, err } = loggerFor(false);
		const board = new ProgressBoard({ logger, heartbeatMs: 10_000 });
		board.start(2);
		board.add("alpha", "revisando");
		board.add("beta", "revisando");
		board.succeed("alpha", "alpha — 2 finding(s) (12s)");
		board.fail("beta", "beta falhou");
		board.stop();
		const text = out.text();
		expect(text).toContain("alpha: revisando…");
		expect(text).toContain("alpha — 2 finding(s) (12s)");
		expect(err.text()).toContain("beta falhou");
		expect(`${text}${err.text()}`).not.toContain("\u001b[");
	});

	test("em pipe emite heartbeat enquanto há tarefa em execução", async () => {
		const { logger, out } = loggerFor(false);
		const board = new ProgressBoard({ logger, heartbeatMs: 5 });
		board.start(1);
		board.add("alpha", "revisando");
		await sleep(40);
		board.stop();
		expect(out.text()).toContain("1 tarefa(s) em execução: alpha");
	});

	test("em TTY pinta o bloco com loader e apaga ao concluir", () => {
		const { logger, out } = loggerFor(true);
		const board = new ProgressBoard({ logger, frameMs: 1_000 });
		board.start(1);
		board.add("alpha", "revisando");
		const painted = out.text();
		expect(painted).toContain("\u001b[2K");
		expect(painted).toContain("alpha");
		expect(painted).toContain("0/1 concluído(s)");
		board.succeed("alpha", "alpha — 1 finding(s) (5s)");
		board.stop();
		expect(out.text()).toContain("✔ alpha — 1 finding(s) (5s)");
	});

	test("retry atualiza o detalhe sem derrubar o board", () => {
		const { logger, out } = loggerFor(false);
		const board = new ProgressBoard({ logger });
		board.start(1);
		board.add("alpha", "revisando");
		board.retry("alpha", "tentativa 2/2", "alpha: repetindo (2/2)");
		board.stop();
		expect(out.text()).toContain("alpha: repetindo (2/2)");
	});
});
