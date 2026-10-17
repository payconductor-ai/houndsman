/**
 * Logger único: cor opcional, spinner em não-TTY e tabela.
 */

import { describe, expect, test } from "bun:test";
import { Logger, SilentLogger } from "../core/logging";

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

describe("Logger", () => {
	test("escreve texto puro quando color=false e sem TTY", () => {
		const out = memoryStream();
		const err = memoryStream();
		const logger = new Logger({
			stdout: out.stream,
			stderr: err.stream,
			color: false,
			isTTY: false,
		});
		logger.info("info");
		logger.success("ok");
		logger.warn("aviso");
		logger.error("falhou");
		logger.step("passo");
		const text = `${out.text()}${err.text()}`;
		expect(text).toContain("info");
		expect(text).toContain("ok");
		expect(text).toContain("aviso");
		expect(text).toContain("falhou");
		expect(text).toContain("passo");
		expect(text).not.toContain("\u001b[");
	});

	test("spinner é nulo em não-TTY", () => {
		const out = memoryStream();
		const logger = new Logger({ stdout: out.stream, isTTY: false });
		expect(logger.spinner("x")).toBeNull();
	});

	test("quiet suprime info/sucesso mas não erro", () => {
		const out = memoryStream();
		const err = memoryStream();
		const logger = new Logger({
			stdout: out.stream,
			stderr: err.stream,
			quiet: true,
			color: false,
		});
		logger.info("info");
		logger.success("ok");
		logger.error("erro");
		expect(out.text()).toBe("");
		expect(err.text()).toContain("erro");
	});

	test("tabela alinha colunas", () => {
		const out = memoryStream();
		const logger = new Logger({ stdout: out.stream, color: false });
		logger.table([
			["id", "findings"],
			["alpha", "2"],
		]);
		expect(out.text()).toContain("id");
		expect(out.text()).toContain("alpha");
	});

	test("SilentLogger não escreve e executa withSpinner", async () => {
		const logger = new SilentLogger();
		logger.info("x");
		const result = await logger.withSpinner("x", async () => 42);
		expect(result).toBe(42);
	});
});
