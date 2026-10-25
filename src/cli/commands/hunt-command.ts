/**
 * Comando `hunt` — harness local (maki) da capability de revisão.
 *
 * A skill `/houndsman hunt` continua sendo o caminho canônico para agentes
 * externos. Este comando é o caminho 100% CLI: usa o mesmo prepare/finalize e
 * despacha cada brief num processo maki headless.
 */

import { existsSync } from "node:fs";
import { runContextCommand } from "../../core/commands/context";
import { parseReviewArgs } from "../../core/commands/review";
import type { HoundsmanConfig } from "../../core/config";
import { resolveReviewWorkspace } from "../../core/engine/review-workspace";
import { type HuntEvent, HuntRunner } from "../../core/hunt/hunt-runner";
import {
	installMaki,
	makiSourceLabel,
	probeMakiVersion,
	requireMakiBinary,
	resolveMakiBinary,
	uninstallMaki,
} from "../../core/hunt/maki-install";
import {
	houndsmanKeyEnvFor,
	requireMakiModel,
	resolveMakiModel,
} from "../../core/hunt/maki-model";
import { SpawnMakiRunner } from "../../core/hunt/maki-runner";
import { formatDuration, type LoggerLike, ProgressBoard } from "../../core/logging";
import { displayPath } from "../../core/paths";
import { ProjectConfig } from "../../core/project-config";
import { touchRunStatus } from "../../core/run-status";
import { ArgParser } from "../arg-parser";
import { prepareProgress, stepDone } from "../progress";
import type { CliContext, Command } from "./command";

/** Texto de ajuda do subcomando. */
const HUNT_HELP = `Uso: houndsman hunt [--pr <n> | --branch <b> | --worktree <path>] [flags]

Harness local (maki) da capability de revisão. A skill \`/houndsman hunt\` continua
existindo: use-a quando a revisão for orquestrada por um agente externo
(Copilot/Claude). O comando abaixo faz prepare → watchdogs via maki → finalize.

Subcomandos:
  install             Baixa o maki fixado para <HOUNDSMAN_HOME>/tools/maki
  doctor              Diagnóstico do harness (binário, modelo, credencial)
  uninstall           Remove o binário gerenciado

Flags:
  --pr <n>            Revisa a PR em worktree dedicado
  --branch <b>        Branch alvo
  --variant <label>   Rótulo da variante A/B (runs separadas para a mesma branch)
  --worktree <path>   Worktree já existente
  --allow-partial     Finaliza mesmo se algum watchdog falhar (findings vazios)
  --no-context        Não coleta o contexto da PR via gh
  --hunt-model <m>    Modelo do maki (provider/model-id)
  --hunt-concurrency  Processos maki simultâneos
  --hunt-timeout      Timeout por watchdog (ms)
  --no-retry          Não repete saída inválida
  --fail-on-blocking  Exit 1 se houver bloqueantes

Instalação:
  houndsman hunt install [--version vX.Y.Z] [--force] [--from <arquivo>]

Ambiente:
  HOUNDSMAN_MAKI_PATH     Binário do maki (vence a instalação gerenciada)
  HOUNDSMAN_MAKI_VERSION  Versão a instalar (default: a fixada no pacote)
  HOUNDSMAN_DEEP_SEEK_API_KEY  Credencial reaproveitada pelo maki (provider deepseek)`;

/** Um subcomando do CLI. */
export class HuntCommand implements Command {
	readonly name = "hunt";

	async run(args: string[], context: CliContext): Promise<number> {
		if (args.includes("--help") || args.includes("-h")) {
			context.out(HUNT_HELP);
			return 0;
		}
		const first = args[0];
		const sub = first && !first.startsWith("-") ? first : undefined;
		const rest = sub ? args.slice(1) : args;
		switch (sub) {
			case undefined:
				return this.runHunt(rest, context);
			case "install":
				return this.install(rest, context);
			case "uninstall":
				return this.uninstall(context);
			case "doctor":
				return this.doctor(context);
			default:
				context.err(`Subcomando desconhecido de 'hunt': '${sub}'.`);
				context.out(HUNT_HELP);
				return 1;
		}
	}

	/** Fluxo completo: prepare → maki → finalize. */
	private async runHunt(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		if (parser.has("--finalize")) {
			context.err(
				"`hunt` já finaliza a revisão; use `houndsman --finalize` isolado.",
			);
			return 1;
		}

		let options: ReturnType<typeof parseReviewArgs>;
		try {
			options = parseReviewArgs(args);
		} catch (error) {
			context.err(messageOf(error));
			return 1;
		}

		const config = await context.config();
		if (config.hunt?.enabled === false) {
			context.err("Harness local desligado (`hunt.enabled: false`).");
			return 1;
		}

		const project = new ProjectConfig(config);
		const harnessStarted = Date.now();
		context.logger.step("Verificando o binário do maki e o modelo do harness…");
		let model: ReturnType<typeof requireMakiModel>;
		let binary: ReturnType<typeof requireMakiBinary>;
		try {
			model = requireMakiModel(project, parser.value("--hunt-model"));
			binary = requireMakiBinary(config.hunt?.binaryPath);
		} catch (error) {
			context.err(messageOf(error));
			return 1;
		}
		stepDone(
			context.logger,
			`Harness pronto: ${model.spec} · ${displayPath(binary.path)}`,
			harnessStarted,
		);
		let workspace: ReturnType<typeof resolveReviewWorkspace>;
		const workspaceStarted = Date.now();
		try {
			workspace = resolveReviewWorkspace(
				{
					cwd: context.cwd,
					base: options.base,
					head: options.head,
					branch: options.branch,
					pr: options.pr,
					worktree: options.worktree,
				},
				{
					worktreesLocation: config.worktrees?.location,
					onProgress: (message) => context.logger.step(message),
				},
			);
		} catch (error) {
			context.err(messageOf(error));
			return 1;
		}
		for (const message of workspace.messages) context.logger.info(message);
		stepDone(
			context.logger,
			`Workspace: ${workspace.branch} em ${displayPath(workspace.root)}`,
			workspaceStarted,
		);

		const engineStarted = Date.now();
		context.logger.step("Abrindo o storage da revisão…");
		const engine = await context.engine({
			root: workspace.root,
			mainRoot: workspace.mainRoot,
		});
		stepDone(context.logger, "Storage pronto", engineStarted);
		try {
			if (options.pr !== undefined && !parser.has("--no-context")) {
				context.logger.step("Coletando o contexto da PR via gh…");
				try {
					const collected = runContextCommand(
						engine.config,
						engine.storage,
						engine.repo,
						{
							branch: workspace.branch,
							variant: options.variant,
							worktreePath: workspace.worktreePath,
							prNumber: workspace.prNumber,
						},
					);
					context.logger.bullet(
						collected.context.available
							? "Contexto da PR coletado via gh."
							: `Contexto da PR indisponível (${collected.context.reason}).`,
					);
				} catch (error) {
					context.logger.warn(
						`Contexto da PR indisponível: ${messageOf(error)}`,
					);
				}
			}

			const session = engine.session({
				...options,
				branch: workspace.branch,
				base: workspace.base,
				head: workspace.head,
				pr: workspace.prNumber,
				worktreePath: workspace.worktreePath,
			});
			const prepared = await session.prepare(prepareProgress(context.logger));
			for (const message of prepared.messages) {
				// O CLI despacha os subagentes; os próximos passos da skill não se aplicam.
				if (SKILL_NEXT_STEPS.test(message)) continue;
				context.logger.info(message);
			}
			if (prepared.activeIds.length === 0) return 0;

			const concurrency =
				positiveInt(parser.value("--hunt-concurrency")) ??
				project.huntConcurrency;
			const timeoutMs =
				positiveInt(parser.value("--hunt-timeout")) ?? project.huntTimeoutMs;
			const retries = parser.has("--no-retry") ? 0 : project.huntRetries;

			context.logger.step(
				`Harness local: ${prepared.activeIds.length} watchdog(s) ` +
					`(${model.spec}, concorrência ${concurrency}).`,
			);
			const board = new ProgressBoard({ logger: context.logger });
			board.start(prepared.activeIds.length);
			const runner = new HuntRunner({
				work: session.context.work,
				root: session.context.root,
				projectName: config.projectName,
				model: model.spec,
				apiKeyEnv: model.apiKeyEnv,
				apiKey: model.apiKey,
				concurrency,
				timeoutMs,
				retries,
				runner: new SpawnMakiRunner(binary.path),
				onEvent: (event) => this.logEvent(board, event, context.logger),
			});
			// Runs longas não podem parecer “timeout” na UI: a skill pinga antes de
			// cada onda; o CLI renova o heartbeat enquanto o maki trabalha.
			const heartbeat = setInterval(() => {
				try {
					touchRunStatus(engine.storage, session.context.review.id);
				} catch {
					// Heartbeat é diagnóstico: nunca derruba a revisão.
				}
			}, 120_000);
			let report: Awaited<ReturnType<typeof runner.run>>;
			try {
				report = await runner.run(prepared.activeIds);
			} finally {
				clearInterval(heartbeat);
				board.stop();
			}
			engine.storage.writeArtifact(session.context.review.id, {
				name: "hunt-report.json",
				kind: "hunt",
				content: `${JSON.stringify(report, null, 2)}\n`,
			});

			context.logger.step(
				`Harness: ${report.totals.done}/${report.totals.watchdogs} watchdog(s), ` +
					`${report.totals.findings} finding(s), $${report.totals.costUsd.toFixed(4)}, ` +
					`${Math.round(report.durationMs / 1000)}s.`,
			);

			const failed = report.watchdogs.filter(
				(watchdog) => watchdog.status === "failed",
			);
			if (failed.length > 0 && !parser.has("--allow-partial")) {
				context.logger.error(
					`Harness falhou em ${failed.length}/${report.watchdogs.length} watchdog(s): ` +
						failed.map((watchdog) => watchdog.watchdogId).join(", "),
				);
				context.logger.info(
					`Staging preservado em ${displayPath(session.context.work.root)}.`,
				);
				context.logger.info(
					"Complete os briefs e rode `houndsman --finalize`, ou repita com `--allow-partial`.",
				);
				return 1;
			}
			if (failed.length > 0) {
				for (const watchdog of failed) {
					session.context.work.writeFinding(
						watchdog.watchdogId,
						`${JSON.stringify(
							{
								watchdogId: watchdog.watchdogId,
								reviewedFiles: [],
								skipped: [`hunt: ${watchdog.error ?? "falhou"}`],
								findings: [],
							},
							null,
							2,
						)}\n`,
					);
				}
				context.logger.warn(
					`${failed.length} watchdog(s) sem findings (registrados em \`skipped\`).`,
				);
			}

			context.logger.step("Consolidando os findings dos watchdogs…");
			const finalized = session.finalize();
			for (const message of finalized.messages) context.logger.info(message);
			context.logger.success(
				`Revisão finalizada: ${displayPath(finalized.reportPath)}`,
			);
			return options.failOnBlocking && finalized.blockers > 0 ? 1 : 0;
		} finally {
			engine.close();
		}
	}

	/** Instala/atualiza o binário gerenciado. */
	private async install(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		try {
			const result = await installMaki({
				version: parser.value("--version"),
				from: parser.value("--from"),
				force: parser.has("--force"),
				log: (message) => context.logger.bullet(message),
			});
			context.logger.success(
				result.skipped
					? `maki v${result.version} já instalado em ${displayPath(result.path)}.`
					: `maki v${result.version} instalado em ${displayPath(result.path)}.`,
			);
			return 0;
		} catch (error) {
			context.err(messageOf(error));
			return 1;
		}
	}

	/** Remove o binário gerenciado. */
	private uninstall(context: CliContext): number {
		const removed = uninstallMaki();
		if (!removed) {
			context.logger.info("Nada para remover: maki gerenciado não está instalado.");
			return 0;
		}
		context.logger.success(`Removido: ${displayPath(removed)}.`);
		return 0;
	}

	/** Diagnóstico do harness local (nunca falha por ausência do maki). */
	private async doctor(context: CliContext): Promise<number> {
		let config: HoundsmanConfig;
		try {
			config = await context.config();
		} catch (error) {
			const message = messageOf(error);
			// Diagnóstico da capability não exige um projeto configurado, mas um
			// config quebrado precisa aparecer.
			if (!message.includes("Nenhuma configuração")) {
				context.err(message);
				return 1;
			}
			context.logger.warn(
				"Sem houndsman.config.ts no diretório atual; usando defaults do harness.",
			);
			config = {
				projectName: "houndsman",
				watchdogIds: [],
				watchdogs: {},
				exclusions: [],
				docMappings: [],
			};
		}
		const project = new ProjectConfig(config);
		const binary = resolveMakiBinary(config.hunt?.binaryPath);

		context.logger.step(
			"Harness local (`hunt`) — opcional; a skill /houndsman hunt não depende dele.",
		);
		if (!binary) {
			context.logger.bullet(
				"⚠️  maki: não instalado — rode `houndsman hunt install` (ou defina HOUNDSMAN_MAKI_PATH).",
			);
		} else if (!existsSync(binary.path)) {
			context.logger.bullet(
				`❌ maki: ${displayPath(binary.path)} (${makiSourceLabel(binary.source)}) não existe.`,
			);
		} else {
			const version = binary.version ?? probeMakiVersion(binary.path);
			context.logger.bullet(
				`✅ maki: ${displayPath(binary.path)} (${makiSourceLabel(binary.source)}` +
					`${version ? `, v${version}` : ""}).`,
			);
		}

		const model = resolveMakiModel(project);
		context.logger.bullet(
			`${model.apiKey ? "✅" : "⚠️ "} modelo: ${model.spec} ` +
				`(${model.apiKey ? "credencial presente" : `defina ${houndsmanKeyEnvFor(model.provider)}`}).`,
		);
		context.logger.bullet(
			`harness: ${project.huntEnabled ? "ligado" : "desligado"} · ` +
				`concorrência ${project.huntConcurrency} · ` +
				`timeout ${Math.round(project.huntTimeoutMs / 1000)}s · ` +
				`retries ${project.huntRetries}.`,
		);
		return 0;
	}

	/** Log de progresso por watchdog. */
	private logEvent(board: ProgressBoard, event: HuntEvent, logger: LoggerLike): void {
		switch (event.type) {
			case "intent":
				if (event.status === "start") {
					logger.step("Reconstruindo a intenção da PR (maki)…");
				} else if (event.status === "done") {
					logger.success(
						`Intenção da PR reconstruída (${event.source ?? "reviewer"}).`,
					);
				} else if (event.status === "skipped") {
					logger.info(`Intenção da PR já disponível (${event.source}).`);
				} else {
					logger.warn(
						`Intenção da PR manteve o modelo determinístico: ${event.error ?? "falha"}`,
					);
				}
				return;
			case "start":
				board.add(event.watchdogId, "revisando");
				return;
			case "retry":
				board.retry(
					event.watchdogId,
					`tentativa ${event.attempt + 1}/${event.maxAttempts}`,
					`${event.watchdogId}: ${event.error} Repetindo ` +
						`(tentativa ${event.attempt + 1}/${event.maxAttempts})…`,
				);
				return;
			case "done": {
				const cost =
					event.metrics.costUsd !== undefined
						? ` · $${event.metrics.costUsd.toFixed(4)}`
						: "";
				board.succeed(
					event.watchdogId,
					`${event.watchdogId} — ${event.findings} finding(s), ` +
						`${event.reviewedFiles} arquivo(s)${cost} ` +
						`(${formatDuration(event.metrics.durationMs)})`,
				);
				return;
			}
			case "failed":
				board.fail(
					event.watchdogId,
					`${event.watchdogId} falhou (${event.attempts} tentativa(s)): ${event.error}`,
				);
				return;
		}
	}
}

/** Últimas mensagens do prepare são instruções para o harness externo. */
const SKILL_NEXT_STEPS =
	/^\s*(Próximo passo: despachar os sub-agentes|Quando os findings estiverem gravados)/;

/** Mensagem de erro legível. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Inteiro positivo da flag, ou `undefined`. */
function positiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
