/**
 * Testes do ambiente tipado (`core/env.ts`).
 *
 * Nenhum valor secreto é impresso; os testes apenas exercitam leitura,
 * normalização e restauração das variáveis.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ENV_NAMES, env, readEnv } from "../core/env";

const original = {
	typeSafe: process.env[ENV_NAMES.typeSafeApiKey],
	deepSeek: process.env[ENV_NAMES.deepSeekApiKey],
	home: process.env[ENV_NAMES.home],
	localAppData: process.env[ENV_NAMES.localAppData],
	xdgDataHome: process.env[ENV_NAMES.xdgDataHome],
};

afterEach(() => {
	restore(ENV_NAMES.typeSafeApiKey, original.typeSafe);
	restore(ENV_NAMES.deepSeekApiKey, original.deepSeek);
	restore(ENV_NAMES.home, original.home);
	restore(ENV_NAMES.localAppData, original.localAppData);
	restore(ENV_NAMES.xdgDataHome, original.xdgDataHome);
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe("env", () => {
	test("lê as chaves canônicas, apara espaços e trata vazio como ausente", () => {
		process.env[ENV_NAMES.typeSafeApiKey] = "  key-1  ";
		process.env[ENV_NAMES.deepSeekApiKey] = "";
		process.env[ENV_NAMES.home] = "  /tmp/houndsman  ";

		const snapshot = readEnv();
		expect(snapshot.typeSafeApiKey).toBe("key-1");
		expect(snapshot.deepSeekApiKey).toBeUndefined();
		expect(snapshot.home).toBe("/tmp/houndsman");
	});

	test("getters refletem alterações em runtime", () => {
		process.env[ENV_NAMES.deepSeekApiKey] = "ds-1";
		expect(env.deepSeekApiKey).toBe("ds-1");
		process.env[ENV_NAMES.deepSeekApiKey] = "ds-2";
		expect(env.deepSeekApiKey).toBe("ds-2");
	});

	test("variável ausente vira undefined", () => {
		delete process.env[ENV_NAMES.typeSafeApiKey];
		expect(env.typeSafeApiKey).toBeUndefined();
	});
});
