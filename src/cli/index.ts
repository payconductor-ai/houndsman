#!/usr/bin/env bun

/**
 * Entrypoint único do `houndsman` — `houndsman [comando]`.
 *
 * Carrega a configuração do projeto (`ReviewConfig`) em runtime (a partir do
 * cwd) e orquestra funções/classes de `core/`. Não importa nenhum caminho do
 * projeto consumidor estaticamente.
 *
 * Comandos:
 *   (default)            Passo 1 — preparar (classificação + briefs + manifesto)
 *   --finalize           Passo 3 — consolidar os findings em review.md
 *   context              Passo 0 — coletar o contexto da PR via `gh`
 *   setup                Cria a configuração inicial do projeto (config + skills)
 *   update               Sincroniza os arquivos auto-gerados (.houndsman/core)
 *   doctor               Valida a configuração e o ambiente (anti-drift)
 *   test                 Roda a suíte de testes da lib
 *   reviewer <id>        Contexto de um revisor (`--rules`, `--json`)
 *
 * Flags: `--base <b>` · `--head <ref>` · `--branch <b>` · `--dir <d>` ·
 *   `--config <path>` · `--clean` · `--no-jev` · `--fail-on-blocking`.
 */

import { runContextCommand } from "../core/commands/context";
import { parseReviewArgs } from "../core/commands/review";
import { renderReviewerContext } from "../core/commands/reviewer";
import { runSetupCommand } from "../core/commands/setup";
import { runLibTests } from "../core/commands/test";
import { runUpdateCommand } from "../core/commands/update";
import { type ReviewConfig, resolveArtifactDir } from "../core/config";
import { loadConfig } from "../core/config-loader";
import { finalize, prepare, resolveBranch } from "../core/orchestrator";
import { relFromRoot } from "../core/paths";
import { checkRegistry } from "../core/registry-check";

const HELP = `Uso: houndsman [comando] [flags]

Comandos:
  (nenhum)            Prepara a revisão (classification + briefs + manifesto)
  --finalize          Consolida os findings em review.md
  context             Coleta o contexto da PR via gh (Passo 0)
  setup               Cria a configuração inicial do projeto (config + skills)
  update              Sincroniza os arquivos auto-gerados (.houndsman/core)
  doctor              Valida a configuração e o ambiente (anti-drift)
  test                Roda a suíte de testes da lib
  reviewer <id>       Contexto de um revisor (--rules, --json)

Flags:
  --config <path>     Caminho do houndsman.config.* (default: detecta no cwd)
  --base <branch>     Base do diff (default: main)
  --head <ref>        Head do diff (default: HEAD)
  --branch <nome>     Branch alvo (default: detecta do git)
  --dir <dir>         Diretório dos artefatos
  --clean             Descarta findings anteriores
  --no-jev            Desativa a pré-análise Jev
  --fail-on-blocking  Exit 1 se houver bloqueantes (com --finalize)`;

function readFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Passo 0 — contexto da PR via `gh`. */
function runContext(config: ReviewConfig, args: string[]): void {
	const { paths, context } = runContextCommand(config, {
		branch: readFlag(args, "--branch"),
		dir: readFlag(args, "--dir"),
	});

	if (context.available) {
		const src = context.source;
		const label = [src?.number ? `#${src.number}` : "", src?.title ?? ""]
			.filter(Boolean)
			.join(" ");
		console.log(
			`[houndsman] PR ${label} (${src?.head} → ${src?.base}), ${context.stats?.files ?? 0} arquivo(s).`,
		);
		console.log(`[houndsman] contexto: ${relFromRoot(paths.context)}`);
		console.log(`[houndsman] brief: ${relFromRoot(paths.brief)}`);
		console.log(
			`[houndsman] próximo passo: subagente resume em ${relFromRoot(paths.summary)}`,
		);
	} else {
		console.log(
			`[houndsman] contexto indisponível (${context.reason}): ${context.detail}`,
		);
		console.log(`[houndsman] marcador: ${relFromRoot(paths.context)}`);
	}
}

/** Valida a configuração do projeto e o ambiente (anti-drift). */
function runDoctor(config: ReviewConfig): void {
	console.log("→ Validando configuração do projeto...");
	const { problems, warnings, jevQuestions } = checkRegistry(config);

	if (problems.length > 0) {
		console.error("\n❌ Problemas na configuração de revisão:\n");
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(
		`  ✅ ${config.reviewerIds.length} revisores, ${jevQuestions} pergunta(s) Jev.`,
	);

	if (warnings.length > 0) {
		console.log(`\n⚠️  ${warnings.length} aviso(s) (não bloqueantes):`);
		for (const warning of warnings) console.log(`  - ${warning}`);
	}

	console.log("\n→ Ambiente:");
	console.log(`  ${Bun.which("git") ? "✅" : "❌"} git`);
	console.log(`  ${Bun.which("gh") ? "✅" : "⚠️ "} gh (opcional — contexto da PR)`);
	console.log(
		`  ${process.env.TYPESAFE_API_KEY ? "✅" : "⚠️ "} TYPESAFE_API_KEY (opcional — pré-análise Jev)`,
	);
}

/** Contexto de um revisor. */
function runReviewer(config: ReviewConfig, args: string[]): void {
	const id = args.find((arg) => !arg.startsWith("-"));

	if (!id || renderReviewerContext(config, id) === null) {
		console.error(
			id
				? `Revisor '${id}' não existe.`
				: "Informe o id do revisor: houndsman reviewer <id>",
		);
		console.error(`Ids válidos: ${config.reviewerIds.join(", ")}`);
		process.exit(1);
	}

	console.log(
		renderReviewerContext(config, id, {
			withRules: args.includes("--rules"),
			json: args.includes("--json"),
		}),
	);
}

/** Passo 1/3 — preparar ou finalizar. */
async function runReview(config: ReviewConfig, args: string[]): Promise<void> {
	const opts = parseReviewArgs(args, resolveArtifactDir(config));
	const branch = resolveBranch(opts);

	if (opts.finalize) {
		const result = finalize(opts, branch, config);
		if (opts.failOnBlocking && result.blockers > 0) process.exit(1);
	} else {
		await prepare(opts, branch, config);
	}
}

/**
 * Executa um subcomando. `--config` sobrepõe a descoberta automática.
 * Comandos que não precisam de projeto (`test`, `setup`) são tratados antes do load.
 */
export async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const first = argv[0];
	const command = first && !first.startsWith("-") ? first : undefined;
	const rest = command ? argv.slice(1) : argv;

	if (command === "test") {
		process.exit(runLibTests());
	}
	if (command === "setup") {
		await runSetupCommand({ cwd: process.cwd(), args: rest });
		return;
	}
	if (command === "update") {
		await runUpdateCommand({ cwd: process.cwd(), args: rest });
		return;
	}

	if (command === "help") {
		console.info(HELP);
		return;
	}

	const { config } = await loadConfig({
		configPath: readFlag(argv, "--config"),
	});

	switch (command) {
		case "context":
			runContext(config, rest);
			return;
		case "doctor":
		case "check":
			runDoctor(config);
			return;
		case "reviewer":
			runReviewer(config, rest);
			return;
		case undefined:
			await runReview(config, rest);
			return;
		default:
			console.error(`Subcomando desconhecido: '${command}'.\n`);
			console.error(HELP);
			process.exit(1);
	}
}

if (import.meta.main) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
