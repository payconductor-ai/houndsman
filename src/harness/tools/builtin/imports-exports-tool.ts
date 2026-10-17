/**
 * Tool `imports_exports` — imports, exports e decorators de um arquivo.
 */

import { z } from "zod";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { PathGuard } from "../path-guard";

const Input = z.object({ file: z.string().min(1) });

/** Lista estrutural do arquivo. */
export class ImportsExportsTool implements AgentTool<z.infer<typeof Input>, unknown> {
	readonly metadata: ToolMetadata = {
		name: "imports_exports",
		description: "Imports, exports e decorators de um arquivo (AST).",
		category: "ast",
		capabilities: ["ast"],
		readOnly: true,
		cost: 2,
		cacheTtlMs: 120_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<unknown>> {
		const guard = new PathGuard(context.repoRoot);
		let path: string;
		try {
			path = guard.relativePath(input.file);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const facts = await context.ast.factsOf(path);
		if (!facts) {
			return { ok: false, error: "AST indisponível para este arquivo." };
		}
		return {
			ok: true,
			data: {
				file: path,
				imports: facts.imports,
				exports: facts.exports,
				decorators: facts.decorators,
			},
		};
	}
}
