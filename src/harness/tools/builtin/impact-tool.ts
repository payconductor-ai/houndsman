/**
 * Tool `impact` — importadores e exports alterados (impacto reverso).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";

const Input = z.object({ file: z.string().optional() });

/** Dependências reversas do diff (top N). */
export class ImpactTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "impact",
		description:
			"Arquivos que importam o diff e exports alterados (impacto reverso).",
		category: "ast",
		capabilities: ["impact"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 300_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const impact = context.agent.impact;
		if (!impact) {
			return {
				ok: true,
				data: { importers: {}, affectedFiles: [], exportedChanges: [] },
			};
		}
		const importers = input.file
			? { [input.file]: impact.importers[input.file] ?? [] }
			: impact.importers;
		return {
			ok: true,
			data: {
				importers,
				affectedFiles: impact.affectedFiles.slice(0, 40),
				exportedChanges: impact.exportedChanges.slice(0, 40),
			},
		};
	}
}
