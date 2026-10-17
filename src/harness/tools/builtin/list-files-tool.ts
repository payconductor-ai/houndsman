/**
 * Tool `list_files` — lista arquivos do repositório (mapa, não conteúdo).
 */

import { z } from "zod";
import { runGit } from "../../../core/git-runner";
import type { AgentTool, ToolMetadata, ToolResult } from "../agent-tool";
import { TOOL_LIMITS } from "../result-limiter";

const Input = z.object({
	directory: z.string().optional(),
	glob: z.string().optional(),
});

/** Lista até 200 arquivos rastreados pelo git. */
export class ListFilesTool implements AgentTool<z.infer<typeof Input>, string[]> {
	readonly metadata: ToolMetadata = {
		name: "list_files",
		description: "Lista arquivos rastreados (diretório/glob opcionais).",
		category: "code",
		capabilities: ["outline"],
		readOnly: true,
		cost: 1,
		cacheTtlMs: 120_000,
	};

	readonly inputSchema = Input;

	async execute(
		input: z.infer<typeof Input>,
		context: import("../tool-context").ToolContext,
	): Promise<ToolResult<string[]>> {
		// `git grep -l` com padrão vazio não lista tudo; usamos `ls-files`.
		let files: string[];
		try {
			const stdout = runGit(["-C", context.repoRoot, "ls-files"]);
			files = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		} catch {
			return { ok: false, error: "não foi possível listar os arquivos (git)." };
		}
		if (input.directory) {
			const prefix = input.directory.replace(/\/+$/, "");
			files = files.filter(
				(file) => file.startsWith(`${prefix}/`) || file === prefix,
			);
		}
		if (input.glob) {
			const matcher = globToRegExp(input.glob);
			files = files.filter((file) => matcher.test(file));
		}
		const truncated = files.length > TOOL_LIMITS.maxFiles;
		return {
			ok: true,
			data: files.slice(0, TOOL_LIMITS.maxFiles),
			truncated,
			...(truncated ? { hint: "Refine com directory/glob." } : {}),
		};
	}
}

/** Converte um glob simples em regex. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index++;
			} else {
				pattern += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			pattern += ".";
			continue;
		}
		pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`);
}
