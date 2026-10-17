#!/usr/bin/env bun

/**
 * Entrypoint único do `houndsman` — `houndsman [comando]`.
 *
 * Carrega a configuração do projeto (`HoundsmanConfig`) em runtime (a partir do
 * cwd) e orquestra funções/classes de `core/`. Não importa nenhum caminho do
 * projeto consumidor estaticamente.
 *
 * Cada comando carrega seus módulos por import dinâmico (lazy) — o startup não
 * paga por `server`, Jev (axios) ou `orchestrator` que o comando não usa.
 *
 * Comandos:
 *   (default)            Passo 1 — preparar (classificação + briefs + manifesto)
 *   --finalize           Passo 3 — consolidar os findings em review.md
 *   context              Passo 0 — coletar o contexto da PR via `gh`
 *   findings <sub>       Triagem/correção dos findings (list/set/done/sync/batch/verify/submit/...)
 *   server               Sobe a UI local de triagem (Bun.serve)
 *   setup                Cria a configuração inicial do projeto (config + skills)
 *   update               Sincroniza os arquivos auto-gerados (.houndsman/core)
 *   doctor               Valida a configuração, o ambiente e a credencial Jev (anti-drift)
 *   test                 Roda a suíte de testes da lib
 *   watchdog <id>        Contexto de um watchdog (`--rules`, `--json`)
 *
 * Flags: `--base <b>` · `--head <ref>` · `--branch <b>` · `--dir <d>` ·
 *   `--config <path>` · `--clean` · `--full` · `--no-jev` · `--fail-on-blocking`.
 */

import { type HoundsmanConfig, resolveArtifactDir } from "../core/config";
import { loadConfig } from "../core/config-loader";
import { relFromRoot } from "../core/paths";

const HELP = `Uso: houndsman [comando] [flags]

Comandos:
  (nenhum)            Prepara a revisão (classification + briefs + manifesto)
  --finalize          Consolida os findings em review.md
  context             Coleta o contexto da PR via gh (Passo 0)
  findings <sub>      Triagem/correção dos findings (list · show · set · done · reset · sync · summary · batch · verify · submit · path)
  server              Sobe a UI local de triagem (--port, --host, --open)
  setup               Cria a configuração inicial do projeto (config + skills)
  update              Sincroniza os arquivos auto-gerados (.houndsman/core)
  doctor              Valida a configuração, o ambiente e a credencial Jev
  test                Roda a suíte de testes da lib
  watchdog <id>       Contexto de um watchdog (--rules, --json)

Flags:
  --config <path>     Caminho do houndsman.config.* (default: detecta no cwd)
  --base <branch>     Base do diff (default: main)
  --head <ref>        Head do diff (default: HEAD)
  --branch <nome>     Branch alvo (default: detecta do git)
  --dir <dir>         Diretório dos artefatos
  --clean             Descarta findings anteriores
  --full              Força review completo (ignora o modo incremental)
  --no-jev            Desativa a pré-análise Jev
  --fail-on-blocking  Exit 1 se houver bloqueantes (com --finalize)

Flags de findings:
  --decision <d>      pending | execute | ignore
  --exec <e>          pending | in_progress | done | stale
  --comment <text>    Comentário/instrução adicional
  --watchdog <id>     Filtra por watchdog (list)
  --severity <s>      Filtra por severidade (list, batch)
  --file <text>       Filtra por trecho do caminho (list)
  --all               Inclui findings ausentes do último relatório
  --json              Saída JSON
  --limit <n>         Limita o nº de itens (list)
  --group <key>       Grupo alvo no batch (default: o primeiro)
  --offset <n>        Paginação dentro do grupo (batch)
  --include-done      Inclui já concluídos no batch
  --apply             (verify) Marca os resolvidos como done
  --fail-on-persisting (verify) Exit 1 se algum blocking persistir
  --include-sent      (submit) Reenvia findings já enviados à PR
  --dry-run           (submit) Só a prévia do envio, sem postar`;

function readFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/** Passo 0 — contexto da PR via `gh`. */
async function runContext(config: HoundsmanConfig, args: string[]): Promise<void> {
	const { runContextCommand } = await import("../core/commands/context");
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

/** Valida a configuração do projeto e o ambiente. */
async function runDoctor(config: HoundsmanConfig): Promise<void> {
	const { checkRegistry } = await import("../core/registry-check");
	console.log("→ Validando configuração do projeto...");
	const { problems, warnings, jevQuestions } = checkRegistry(config);

	if (problems.length > 0) {
		console.error("\n❌ Problemas na configuração de revisão:\n");
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(
		`  ✅ ${config.watchdogIds.length} watchdogs, ${jevQuestions} pergunta(s) Jev.`,
	);

	if (warnings.length > 0) {
		console.log(`\n⚠️  ${warnings.length} aviso(s) (não bloqueantes):`);
		for (const warning of warnings) console.log(`  - ${warning}`);
	}

	console.log("\n→ Ambiente:");
	console.log(`  ${Bun.which("git") ? "✅" : "❌"} git`);
	console.log(`  ${Bun.which("gh") ? "✅" : "⚠️ "} gh (opcional — contexto da PR)`);
	await reportJevCredential();
}

/**
 * Reporta o estado da credencial Jev: presença e validade (chamada mínima).
 * Fail-open — nunca altera o exit code (`doctor` é diagnóstico).
 */
async function reportJevCredential(): Promise<void> {
	const { JevClient } = await import("../core/jev");
	const client = new JevClient();
	if (!client.isConfigured()) {
		console.log("  ⚠️  TYPESAFE_API_KEY (opcional — pré-análise Jev)");
		return;
	}
	const check = await client.validateCredential();
	if (check.ok) {
		console.log(`  ✅ Jev: credencial válida (modelo ${check.model}).`);
	} else if (check.kind === "invalid") {
		console.log(`  ❌ Jev: credencial inválida — ${check.detail}`);
	} else {
		console.log(`  ⚠️  Jev: não foi possível validar — ${check.detail}`);
	}
}

/** Contexto de um watchdog. */
async function runWatchdog(config: HoundsmanConfig, args: string[]): Promise<void> {
	const { renderWatchdogContext } = await import("../core/commands/watchdog");
	const id = args.find((arg) => !arg.startsWith("-"));

	if (!id || renderWatchdogContext(config, id) === null) {
		console.error(
			id
				? `Watchdog '${id}' não existe.`
				: "Informe o id do watchdog: houndsman watchdog <id>",
		);
		console.error(`Ids válidos: ${config.watchdogIds.join(", ")}`);
		process.exit(1);
	}

	console.log(
		renderWatchdogContext(config, id, {
			withRules: args.includes("--rules"),
			json: args.includes("--json"),
		}),
	);
}

/**
 * Subcomando `findings` — triagem/correção dos findings (list/show/set/done/reset/
 * sync/summary/batch/verify/path). Deixa o agente interagir com o estado sem abrir
 * o JSON. O `verify` é assíncrono (consulta opcional ao Jev) — roteado à parte.
 */
async function runFindings(config: HoundsmanConfig, args: string[]): Promise<void> {
	const { runFindingsCommand, runSubmitCommand, runVerifyCommand } = await import(
		"../core/commands/findings"
	);
	const sub = args.find((arg) => !arg.startsWith("-"));
	const result =
		sub === "verify"
			? await runVerifyCommand(config, args)
			: sub === "submit"
				? await runSubmitCommand(config, args)
				: runFindingsCommand(config, args);
	if (result.exitCode !== 0) {
		console.error(result.output);
		process.exit(result.exitCode);
	}
	console.log(result.output);
}

/** Abre a URL no navegador padrão (best-effort, por plataforma). */
function openBrowser(url: string): void {
	try {
		const command =
			process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: process.platform === "darwin"
					? ["open", url]
					: ["xdg-open", url];
		Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
	} catch {
		// best-effort — se não abrir, o usuário copia a URL.
	}
}

/** Subcomando `server` — sobe a UI local de triagem. */
async function runServer(config: HoundsmanConfig, args: string[]): Promise<void> {
	const { startServer } = await import("../server");
	const port = Number(readFlag(args, "--port")) || 7331;
	const host = readFlag(args, "--host") ?? "127.0.0.1";
	const { url } = startServer({ config, port, host });
	console.log(`[houndsman] servidor em ${url}`);
	console.log("[houndsman] Ctrl+C para encerrar.");
	if (args.includes("--open")) openBrowser(url);
}

/** Passo 1/3 — preparar ou finalizar. */
async function runReview(config: HoundsmanConfig, args: string[]): Promise<void> {
	const [{ parseReviewArgs }, { finalize, prepare, resolveBranch }] = await Promise.all(
		[import("../core/commands/review"), import("../core/orchestrator")],
	);
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
		const { runLibTests } = await import("../core/commands/test");
		process.exit(runLibTests());
	}
	if (command === "setup") {
		const { runSetupCommand } = await import("../core/commands/setup");
		await runSetupCommand({ cwd: process.cwd(), args: rest });
		return;
	}
	if (command === "update") {
		const { runUpdateCommand } = await import("../core/commands/update");
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
			await runContext(config, rest);
			return;
		case "doctor":
		case "check":
			await runDoctor(config);
			return;
		case "watchdog":
			await runWatchdog(config, rest);
			return;
		case "findings":
			await runFindings(config, rest);
			return;
		case "server":
			await runServer(config, rest);
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
