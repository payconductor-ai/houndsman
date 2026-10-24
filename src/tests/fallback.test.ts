/** Fallback de classificação (arquivos sem dono). */

import { describe, expect, test } from "bun:test";
import { defineHoundsmanConfig } from "../core/config";
import { classifyEntries } from "../core/file-classifier";
import { checkRegistry } from "../core/registry-check";
import { defineWatchdog } from "../core/types";

const alpha = defineWatchdog({
	id: "alpha",
	name: "Alpha",
	description: "Domínio alpha.",
	scope: "src/alpha/**",
	classify: [{ value: "^src/alpha/" }],
	rules: [{ severity: "blocking", text: "Nunca usar any." }],
	contextFiles: [],
});

const fallback = defineWatchdog({
	id: "default",
	name: "Padrões gerais",
	description: "Fallback de lógica/domínio.",
	scope: "arquivos sem dono",
	fallback: true,
	rules: [
		{
			severity: "attention",
			text: "Promover: a lógica do domínio respeita as invariantes.",
		},
	],
	contextFiles: [],
});

const config = defineHoundsmanConfig({
	projectName: "Fallback",
	watchdogs: { alpha, default: fallback },
	exclusions: [],
	docMappings: [],
});

describe("classificação com fallback", () => {
	test("arquivo sem dono vai para o fallback; com dono fica no domínio", () => {
		const result = classifyEntries(
			[
				{ path: "src/alpha/a.ts", status: "modified" },
				{ path: "src/other/b.ts", status: "modified" },
			],
			config,
			{},
		);
		expect(result.watchdogs.alpha).toEqual(["src/alpha/a.ts"]);
		expect(result.watchdogs.default).toEqual(["src/other/b.ts"]);
		expect(result.unclassified).toEqual([]);
	});

	test("múltiplos fallbacks geram warning (primeiro vence)", () => {
		const second = defineWatchdog({
			...fallback,
			id: "default2",
		});
		const duplicated = defineHoundsmanConfig({
			...config,
			watchdogs: { ...config.watchdogs, default2: second },
		});
		const result = classifyEntries(
			[{ path: "src/other/b.ts", status: "modified" }],
			duplicated,
			{},
		);
		expect(result.watchdogs.default).toEqual(["src/other/b.ts"]);
		expect(result.watchdogs.default2).toBeUndefined();
		const { warnings } = checkRegistry(duplicated);
		expect(
			warnings.some((item) => item.includes("Mais de um watchdog fallback")),
		).toBe(true);
	});
});
