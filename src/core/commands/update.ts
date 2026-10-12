/**
 * Subcomando `update` — sincroniza os arquivos **auto-gerados** da camada `.houndsman/`.
 *
 * Reescreve `core/types.ts`, `core/skill/*.md`, `.houndsman/.gitignore` e os
 * ponteiros de skill dos harnesses. Nunca toca nos arquivos do usuário
 * (`reviewers/`, `doc-mappings.ts`, `exclusions.ts`, `houndsman.config.ts`).
 */

import { createScaffoldContext, syncGeneratedFiles } from "./scaffold";

export type UpdateOptions = {
	cwd: string;
	args: string[];
};

/** Sincroniza os arquivos auto-gerados da camada de projeto. */
export async function runUpdateCommand(options: UpdateOptions): Promise<void> {
	const ctx = createScaffoldContext(options.cwd, options.args, false);

	console.log(`→ Sincronizando arquivos auto-gerados em ${ctx.cwd}`);

	syncGeneratedFiles(ctx);

	for (const path of ctx.generated) console.log(`  ~ ${path} (auto)`);

	console.log("\nArquivos do usuário não foram tocados:");
	console.log(
		"  .houndsman/reviewers/ · exclusions.ts · doc-mappings.ts · houndsman.config.ts",
	);
}
