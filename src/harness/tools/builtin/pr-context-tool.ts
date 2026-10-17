/**
 * Tool `pr_context` — contexto resumido da PR (já compactado).
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";

/** Contexto da PR para orientação do agente. */
export class PrContextTool implements AgentTool<Record<string, never>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "pr_context",
		description: "Contexto resumido da PR (objetivo, motivação, mudanças).",
		category: "context",
		capabilities: ["read"],
		readOnly: true,
		cost: 1,
		cacheTtlMs: 300_000,
	};

	readonly inputSchema = z.object({});

	async execute(
		_input: Record<string, never>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		return {
			ok: true,
			data: {
				project: context.agent.projectName,
				branch: context.agent.branch,
				watchdog: context.agent.watchdog.id,
				scope: context.agent.watchdog.scope,
				context: context.agent.context ?? null,
				files: context.agent.files,
				overflow: context.agent.overflow,
				deleted: context.agent.deleted,
				docs: context.agent.docs,
			},
		};
	}
}
