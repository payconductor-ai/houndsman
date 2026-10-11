/**
 * Subcomando `setup` — cria a configuração inicial do houndsman no projeto.
 *
 * Gera a camada `.houndsman/`: arquivos do usuário (config, revisores, exclusões,
 * mapeamentos) + arquivos auto-gerados (tipos, skill, `.runs/.gitignore`,
 * ponteiros de harness). O `houndsman update` sincroniza só os auto-gerados.
 *
 * A camada é **autocontida** — não importa o pacote `houndsman` em runtime, o que
 * permite instalar o CLI **globalmente** e usar `bun run houndsman` sem
 * dependência local no projeto.
 *
 * Idempotente: arquivos do usuário só são sobrescritos com `--force`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createScaffoldContext,
	type ScaffoldContext,
	syncGeneratedFiles,
	writeUserLayer,
} from "./scaffold";

export type SetupOptions = {
	cwd: string;
	args: string[];
};

/**
 * Garante o script `houndsman` no `package.json` do projeto (para
 * `bun run houndsman [...]`), sem reformatar o restante do arquivo.
 */
function ensurePackageScript(ctx: ScaffoldContext): void {
	const pkgPath = join(ctx.cwd, "package.json");
	if (!existsSync(pkgPath)) return;

	const raw = readFileSync(pkgPath, "utf8");
	if (raw.includes('"houndsman"')) {
		ctx.skipped.push("package.json#scripts.houndsman");
		return;
	}
	const scriptsBlock = /"scripts"\s*:\s*\{/;
	if (!scriptsBlock.test(raw)) return;

	writeFileSync(
		pkgPath,
		raw.replace(scriptsBlock, (match) => `${match}\n\t\t"houndsman": "houndsman",`),
	);
	ctx.created.push("package.json#scripts.houndsman");
}

/** Cria a configuração inicial do projeto. */
export async function runSetupCommand(options: SetupOptions): Promise<void> {
	const ctx = createScaffoldContext(
		options.cwd,
		options.args,
		options.args.includes("--force"),
	);

	console.log(`→ Configurando houndsman em ${ctx.cwd} (projeto: ${ctx.projectName})`);

	writeUserLayer(ctx);
	syncGeneratedFiles(ctx);
	ensurePackageScript(ctx);

	for (const path of ctx.created) console.log(`  + ${path}`);
	for (const path of ctx.skipped) console.log(`  = ${path} (mantido)`);
	for (const path of ctx.generated) console.log(`  ~ ${path} (auto)`);

	console.log("\nPróximos passos:");
	console.log("  1. Ajuste `houndsman.config.ts` e `.houndsman/reviewers/`.");
	console.log("  2. Valide: bun run houndsman doctor");
	console.log("  3. Prepare a revisão: bun run houndsman");
	console.log("  ·  Sincronizar arquivos auto-gerados: bun run houndsman update");
}
