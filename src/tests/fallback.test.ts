/**
 * Fallback de classificação e findings emergentes (lógica/domínio).
 */

import { describe, expect, test } from "bun:test";
import { defineHoundsmanConfig } from "../core/config";
import { classifyEntries } from "../core/file-classifier";
import { checkRegistry } from "../core/registry-check";
import { defineWatchdog } from "../core/types";
import { AgentState } from "../harness/investigation/agent-state";
import { EvidenceVerifier } from "../harness/investigation/evidence-verifier";
import { FindingCritic } from "../harness/investigation/finding-critic";
import { FindingValidator } from "../harness/validation/finding-validator";

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
	allowEmergentFindings: true,
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

describe("findings emergentes", () => {
	const file = "a.ts";
	const content = "const x = 1;\n";
	const state = new AgentState();
	const evidence = state.addEvidence({
		file,
		startLine: 1,
		endLine: 1,
		snippet: content.trim(),
		kind: "definition",
		sourceTool: "test",
		confidence: 0.9,
	});
	const draft = {
		rule: "Lógica: a função fazA na verdade fazB",
		severity: "blocking" as const,
		file,
		line: 1,
		message: "comportamento diverge do nome",
		action: "renomear ou corrigir",
		evidenceIds: [evidence.id],
		confidence: 0.9,
	};
	const verifier = new EvidenceVerifier({
		allowedFiles: [file],
		readFile: (path) => (path === file ? content : null),
	});

	test("crítico aceita e limita a severidade quando habilitado", () => {
		const critic = new FindingCritic({
			knownRules: new Set([fallback.rules[0]?.text ?? ""]),
			verifier,
			allowEmergentFindings: true,
		});
		const decision = critic.reviewOne(draft, state);
		expect(decision.verdict).toBe("keep");
		expect(decision.draft.severity).toBe("attention");
	});

	test("crítico descarta quando o opt-in está desligado", () => {
		const critic = new FindingCritic({
			knownRules: new Set([fallback.rules[0]?.text ?? ""]),
			verifier,
		});
		const decision = critic.reviewOne(draft, state);
		expect(decision.verdict).toBe("drop");
		expect(decision.reason).toContain("desabilitado");
	});

	test("validador espelha a mesma regra", () => {
		const report = {
			watchdogId: "default",
			reviewedFiles: [file],
			skipped: [],
			findings: [draft],
		};
		const allowed = new FindingValidator({
			watchdogId: "default",
			knownRules: new Set([fallback.rules[0]?.text ?? ""]),
			allowedFiles: new Set([file]),
			overflow: new Set(),
			readFile: (path) => (path === file ? content : null),
			allowEmergentFindings: true,
		}).validate(report);
		expect(allowed.report.findings[0]?.severity).toBe("attention");
		expect(allowed.dropped).toHaveLength(0);

		const denied = new FindingValidator({
			watchdogId: "default",
			knownRules: new Set([fallback.rules[0]?.text ?? ""]),
			allowedFiles: new Set([file]),
			overflow: new Set(),
			readFile: (path) => (path === file ? content : null),
		}).validate(report);
		expect(denied.report.findings).toHaveLength(0);
	});

	test("finding emergente sem descrição é descartado", () => {
		const critic = new FindingCritic({
			knownRules: new Set([fallback.rules[0]?.text ?? ""]),
			verifier,
			allowEmergentFindings: true,
		});
		const decision = critic.reviewOne({ ...draft, rule: "Lógica:" }, state);
		expect(decision.verdict).toBe("drop");
	});
});
