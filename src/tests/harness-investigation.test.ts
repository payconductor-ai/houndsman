/**
 * Investigação: planner, evidência, crítico e cobertura.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentState } from "../harness/investigation/agent-state";
import { EvidenceVerifier } from "../harness/investigation/evidence-verifier";
import { FindingCritic } from "../harness/investigation/finding-critic";
import { InvestigationPlanner } from "../harness/investigation/investigation-planner";
import { RuleAnalyzer } from "../harness/investigation/rule-analyzer";

const RULE = "Nunca usar `any`.";
const analyses = new RuleAnalyzer().analyze([
	{ severity: "suggestion", text: "Evitar console.log." },
	{ severity: "blocking", text: RULE },
	{ severity: "attention", text: "Validar entrada do usuário." },
]);

const dir = mkdtempSync(join(tmpdir(), "houndsman-evidence-"));
const file = join(dir, "a.ts");
writeFileSync(file, "const x: any = 1;\nconsole.log(x);\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function verifier(): EvidenceVerifier {
	return new EvidenceVerifier({
		allowedFiles: ["a.ts"],
		readFile: (path) =>
			path === "a.ts" ? "const x: any = 1;\nconsole.log(x);\n" : null,
	});
}

describe("InvestigationPlanner", () => {
	test("prioriza por severidade e calcula estimativa", () => {
		const plan = new InvestigationPlanner().plan(
			{ watchdogId: "alpha", files: ["a.ts"], symbols: [] },
			analyses,
		);
		expect(plan.tasks[0]?.rule).toBe(RULE);
		expect(plan.tasks[0]?.severity).toBe("blocking");
		expect(plan.totalFiles).toBe(1);
		expect(plan.estimatedToolCalls).toBeGreaterThan(0);
	});

	test("filtra arquivos por hint de path", () => {
		const [analysis] = new RuleAnalyzer().analyze([
			{
				severity: "attention",
				text: "Evitar: query no banco em rota.",
				hints: { paths: ["^src/alpha/"] },
			},
		]);
		const plan = new InvestigationPlanner().plan(
			{
				watchdogId: "alpha",
				files: ["src/alpha/a.ts", "src/beta/b.ts"],
				symbols: [],
			},
			analysis ? [analysis] : [],
		);
		expect(plan.tasks[0]?.files).toEqual(["src/alpha/a.ts"]);
	});
});

describe("EvidenceVerifier", () => {
	test("aceita snippet na linha e reancora quando deslocado", () => {
		const state = new AgentState();
		const exact = state.addEvidence({
			file: "a.ts",
			startLine: 1,
			endLine: 1,
			snippet: "const x: any = 1;",
			kind: "definition",
			sourceTool: "t",
			confidence: 0.9,
		});
		const moved = state.addEvidence({
			file: "a.ts",
			startLine: 9,
			endLine: 9,
			snippet: "console.log(x);",
			kind: "reference",
			sourceTool: "t",
			confidence: 0.7,
		});
		expect(verifier().verify(exact).valid).toBe(true);
		const verdict = verifier().verify(moved);
		expect(verdict.valid).toBe(true);
		expect(verdict.startLine).toBe(2);
	});

	test("rejeita arquivo fora do domínio e snippet inexistente", () => {
		const state = new AgentState();
		const outside = state.addEvidence({
			file: "b.ts",
			startLine: 1,
			endLine: 1,
			snippet: "x",
			kind: "definition",
			sourceTool: "t",
			confidence: 1,
		});
		const missing = state.addEvidence({
			file: "a.ts",
			startLine: 1,
			endLine: 1,
			snippet: "não existe",
			kind: "definition",
			sourceTool: "t",
			confidence: 1,
		});
		expect(verifier().verify(outside).valid).toBe(false);
		expect(verifier().verify(missing).valid).toBe(false);
	});

	test("draft sem evidência válida é inválido", () => {
		const state = new AgentState();
		const evidence = state.addEvidence({
			file: "a.ts",
			startLine: 1,
			endLine: 1,
			snippet: "const x: any = 1;",
			kind: "definition",
			sourceTool: "t",
			confidence: 0.9,
		});
		const draft = {
			rule: RULE,
			severity: "blocking" as const,
			file: "a.ts",
			line: 1,
			message: "m",
			action: "a",
			evidenceIds: [evidence.id],
			confidence: 0.9,
		};
		expect(verifier().verifyDraft(draft, state).valid).toBe(true);
		expect(
			verifier().verifyDraft({ ...draft, evidenceIds: ["nope"] }, state).valid,
		).toBe(false);
	});
});

describe("FindingCritic", () => {
	const state = new AgentState();
	const evidence = state.addEvidence({
		file: "a.ts",
		startLine: 1,
		endLine: 1,
		snippet: "const x: any = 1;",
		kind: "definition",
		sourceTool: "t",
		confidence: 0.9,
	});
	const critic = new FindingCritic({
		knownRules: new Set([RULE]),
		verifier: verifier(),
	});
	const draft = {
		rule: RULE,
		severity: "blocking" as const,
		file: "a.ts",
		line: 1,
		message: "m",
		action: "a",
		evidenceIds: [evidence.id],
		confidence: 0.9,
	};

	test("keep com evidência e confiança", () => {
		expect(critic.reviewOne(draft, state).verdict).toBe("keep");
	});

	test("drop sem evidência, sem regra ou confiança baixa", () => {
		expect(critic.reviewOne({ ...draft, evidenceIds: [] }, state).verdict).toBe(
			"drop",
		);
		expect(critic.reviewOne({ ...draft, rule: "inexistente" }, state).verdict).toBe(
			"drop",
		);
		expect(critic.reviewOne({ ...draft, confidence: 0.2 }, state).verdict).toBe(
			"drop",
		);
	});

	test("downgrade quando a confiança não sustenta a severidade", () => {
		expect(critic.reviewOne({ ...draft, confidence: 0.5 }, state).verdict).toBe(
			"downgrade",
		);
	});
});

describe("AgentState", () => {
	test("cobertura e hipóteses sem duplicar", () => {
		const state = new AgentState();
		state.addHypothesis("a");
		state.addHypothesis("a");
		expect(state.hypotheses).toEqual(["a"]);
		state.setCoverage(RULE, "skipped", "motivo");
		expect(state.isCovered(RULE)).toBe(true);
		state.setCoverage(RULE, "checked");
		expect(state.coverageOf(RULE)?.status).toBe("checked");
	});
});
