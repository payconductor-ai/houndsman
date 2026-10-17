/**
 * Tools fake para a suíte do harness.
 */

import { z } from "zod";
import type {
	AgentTool,
	ToolContext,
	ToolMetadata,
	ToolResult,
} from "../../harness/tools/agent-tool";

/** Tool de eco (testa registry/middleware). */
export class EchoTool implements AgentTool<{ value: string }, { value: string }> {
	readonly metadata: ToolMetadata = {
		name: "echo",
		description: "Devolve o valor recebido.",
		category: "context",
		capabilities: ["read"],
		readOnly: true,
		cost: 1,
		cacheTtlMs: 60_000,
	};

	readonly inputSchema = z.object({ value: z.string() });

	async execute(
		input: { value: string },
		_context: ToolContext,
	): Promise<ToolResult<{ value: string }>> {
		return { ok: true, data: { value: input.value } };
	}
}

/** Tool que produz evidência para o estado. */
export class EvidenceTool implements AgentTool<{ file: string }, unknown> {
	readonly metadata: ToolMetadata = {
		name: "evidence",
		description: "Produz uma evidência fake.",
		category: "evidence",
		capabilities: ["read"],
		readOnly: true,
		cost: 1,
	};

	readonly inputSchema = z.object({ file: z.string() });

	async execute(
		input: { file: string },
		_context: ToolContext,
	): Promise<ToolResult<unknown>> {
		return {
			ok: true,
			data: { file: input.file },
			evidence: [
				{
					id: "",
					file: input.file,
					startLine: 1,
					endLine: 1,
					snippet: "const x: any = 1;",
					kind: "definition",
					sourceTool: "evidence",
					confidence: 0.9,
				},
			],
		};
	}
}
