/**
 * Subcomando `setup` — cria a configuração inicial do houndsman no projeto.
 *
 * Gera a camada `.houndsman/`: arquivos do usuário (config, watchdogs, exclusões,
 * mapeamentos) + arquivos auto-gerados (tipos, skill, `.houndsman/.gitignore`,
 * ponteiros de harness). O `houndsman update` sincroniza só os auto-gerados.
 *
 * A camada é **autocontida** — não importa o pacote `@payconductor/houndsman` em
 * runtime, o que permite instalar o CLI **globalmente** e usar `bun run houndsman`
 * sem dependência local no projeto.
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

/** Cria a configuração inicial do projeto. Devolve as mensagens do CLI. */
export async function runSetupCommand(options: SetupOptions): Promise<string[]> {
	const ctx = createScaffoldContext(
		options.cwd,
		options.args,
		options.args.includes("--force"),
	);

	const messages = [
		`→ Configurando houndsman em ${ctx.cwd} (projeto: ${ctx.projectName})`,
	];

	writeUserLayer(ctx);
	syncGeneratedFiles(ctx);
	ensurePackageScript(ctx);

	for (const path of ctx.created) messages.push(`  + ${path}`);
	for (const path of ctx.skipped) messages.push(`  = ${path} (mantido)`);
	for (const path of ctx.generated) messages.push(`  ~ ${path} (auto)`);

	messages.push(
		"\nPróximos passos:",
		"  1. Ajuste `houndsman.config.ts` e `.houndsman/watchdogs/`.",
		"  2. Valide: bun run houndsman doctor",
		"  3. Prepare a revisão: bun run houndsman",
		"  ·  Sincronizar arquivos auto-gerados: bun run houndsman update",
	);
	return messages;
}
