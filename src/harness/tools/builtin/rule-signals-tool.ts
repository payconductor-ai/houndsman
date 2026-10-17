/**
 * Tool `rule_signals` — traduz uma regra em sinais e checks.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";

const Input = z.object({ rule: z.string().min(3) });

/** Devolve a `RuleAnalysis` determinística da regra. */
export class RuleSignalsTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "rule_signals",
		description: "Sinais, keywords e checks sugeridos para uma regra do watchdog.",
		category: "rules",
		capabilities: ["rules"],
		readOnly: true,
		cost: 1,
		cacheTtlMs: 300_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const analysis =
			context.rules.get(input.rule) ??
			[...context.rules.values()].find((item) => item.rule.includes(input.rule));
		if (!analysis) {
			return { ok: false, error: "regra não encontrada no watchdog." };
		}
		return { ok: true, data: analysis };
	}
}
