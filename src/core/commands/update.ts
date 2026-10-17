/**
 * Subcomando `update` — sincroniza os arquivos **auto-gerados** da camada `.houndsman/`.
 *
 * Reescreve `core/types.ts`, `core/skill/*.md`, `.houndsman/.gitignore` e os
 * ponteiros de skill dos harnesses. Nunca toca nos arquivos do usuário
 * (`watchdogs/`, `doc-mappings.ts`, `exclusions.ts`, `houndsman.config.ts`).
 */

import { createScaffoldContext, syncGeneratedFiles } from "./scaffold";

export type UpdateOptions = {
	cwd: string;
	args: string[];
};

/** Sincroniza os arquivos auto-gerados da camada de projeto. Devolve mensagens. */
export async function runUpdateCommand(options: UpdateOptions): Promise<string[]> {
	const ctx = createScaffoldContext(options.cwd, options.args, false);
	const messages = [`→ Sincronizando arquivos auto-gerados em ${ctx.cwd}`];

	syncGeneratedFiles(ctx);

	for (const path of ctx.generated) messages.push(`  ~ ${path} (auto)`);

	messages.push(
		"\nArquivos do usuário não foram tocados:",
		"  .houndsman/watchdogs/ · exclusions.ts · doc-mappings.ts · houndsman.config.ts",
	);
	return messages;
}
