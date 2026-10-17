/**
 * ReviewAgent — máquina de estados com provider fake e tools reais.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SilentReporter } from "../harness/agent/agent-reporter";
import { ReviewAgent } from "../harness/agent/review-agent";
import { fakeAgentContext, fakeAgentDeps } from "./fixtures/fake-investigation";
import { FakeModelProvider } from "./fixtures/fake-model-provider";

const RULE = "Nunca usar `any`.";

const dir = mkdtempSync(join(tmpdir(), "houndsman-agent-"));
mkdirSync(join(dir, "src/alpha"), { recursive: true });
writeFileSync(join(dir, "src/alpha/a.ts"), "const x: any = 1;\nconsole.log(x);\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Provider que investiga com `read_file_range` e devolve um draft. */
function investigatingProvider(options: { withEvidence?: boolean } = {}) {
	return new FakeModelProvider(async (request, index) => {
		if (index === 0) return { hypotheses: ["uso de any"] };
		if (index === 1) return { taskIds: ["rule-0"] };
		const tool = request.tools?.read_file_range;
		if (!tool) throw new Error("tool read_file_range ausente");
		const raw = await tool.execute({
			path: "src/alpha/a.ts",
			startLine: 1,
			endLine: 2,
		});
		const parsed = JSON.parse(raw) as {
			evidence?: { id: string }[];
		};
		const evidenceId = parsed.evidence?.[0]?.id;
		return {
			findingDrafts: [
				{
					rule: RULE,
					severity: "blocking",
					file: "src/alpha/a.ts",
					line: 1,
					message: "Uso de any.",
					action: "Tipar o valor.",
					evidenceIds:
						options.withEvidence === false || !evidenceId ? [] : [evidenceId],
					confidence: 0.9,
				},
			],
			coverage: [
				{ rule: RULE, status: "checked" },
				{ rule: "Validar entrada do usuário.", status: "not_applicable" },
				{ rule: "Evitar console.log.", status: "checked" },
			],
		};
	});
}

function buildAgent(provider: FakeModelProvider): {
	agent: ReviewAgent;
	reporter: SilentReporter;
} {
	const reporter = new SilentReporter();
	const deps = fakeAgentDeps(provider, {
		context: fakeAgentContext({ repoRoot: dir }),
		reporter,
	});
	return { agent: new ReviewAgent(deps), reporter };
}

describe("ReviewAgent", () => {
	test("ORIENT→PLAN→INVESTIGATE→VERIFY→CONCLUDE com evidência", async () => {
		const { agent, reporter } = buildAgent(investigatingProvider());
		const result = await agent.run();
		expect(result.status).toBe("done");
		expect(result.report?.findings).toHaveLength(1);
		expect(result.report?.findings[0]?.evidence).toContain("src/alpha/a.ts");
		expect(result.report?.reviewedFiles).toContain("src/alpha/a.ts");
		const transitions = reporter.journal.transitions.map((item) => item.to);
		expect(transitions).toEqual(["PLAN", "INVESTIGATE", "VERIFY", "CONCLUDE"]);
		expect(result.state.coverage.size).toBe(3);
	});

	test("VERIFY é obrigatório: draft sem evidência é descartado", async () => {
		const { agent } = buildAgent(investigatingProvider({ withEvidence: false }));
		const result = await agent.run();
		expect(result.status).toBe("done");
		expect(result.report?.findings).toHaveLength(0);
		const coverage = result.state.coverageOf(RULE);
		expect(coverage?.status).toBe("checked");
		expect(coverage?.reason).toContain("refutado");
	});

	test("toda regra termina com cobertura (mesmo sem o modelo cobrir)", async () => {
		const provider = new FakeModelProvider((_request, index) => {
			if (index === 0) return { hypotheses: [] };
			if (index === 1) return { taskIds: [] };
			return { findingDrafts: [], coverage: [] };
		});
		const { agent } = buildAgent(provider);
		const result = await agent.run();
		expect(result.state.coverage.size).toBe(3);
		expect(
			[...result.state.coverage.values()].every(
				(item) => item.status === "skipped",
			),
		).toBe(true);
	});

	test("falha do provider vira status failed", async () => {
		const provider = new FakeModelProvider((_request, index) => {
			if (index === 0) throw new Error("boom");
			if (index === 1) throw new Error("boom");
			throw new Error("429 rate limit");
		});
		const { agent } = buildAgent(provider);
		const result = await agent.run();
		expect(result.status).toBe("failed");
		expect(result.error).toContain("429");
	});
});
