/**
 * Progresso do CLI por etapa do prepare (apresentação).
 *
 * O core emite eventos (`PrepareProgressEvent`); aqui eles viram spinner/linha
 * com a duração de cada fase — o `hunt` começa a dar sinal de vida antes do
 * primeiro `Discovery:`.
 */

import { formatDuration, type LoggerLike, PhaseReporter } from "../core/logging";
import type { PrepareProgress, PrepareStage } from "../core/orchestrator";

/** Texto de cada etapa (início no gerúndio, fim no particípio). */
export const PREPARE_STAGE_TEXT: Record<PrepareStage, { start: string; done: string }> = {
	diff: { start: "Lendo o diff da revisão", done: "Diff lido" },
	ast: { start: "Analisando a AST dos arquivos alterados", done: "AST analisada" },
	classify: {
		start: "Classificando os arquivos por watchdog",
		done: "Classificação concluída",
	},
	impact: { start: "Medindo o impacto nos importadores", done: "Impacto calculado" },
	jev: { start: "Pré-analisando o diff (Jev/IA)", done: "Pré-análise concluída" },
	context: { start: "Resumindo o contexto da PR", done: "Contexto resumido" },
	technical: {
		start: "Consolidando os pontos técnicos",
		done: "Pontos técnicos prontos",
	},
	"ai-plans": { start: "Planejando os briefs com IA", done: "Planos de brief prontos" },
	briefs: { start: "Gerando os briefs", done: "Briefs gerados" },
	manifest: { start: "Gravando o manifesto da revisão", done: "Manifesto gravado" },
};

/** Cria o callback de progresso do prepare ligado ao logger do CLI. */
export function prepareProgress(logger: LoggerLike): PrepareProgress {
	const reporter = new PhaseReporter(logger);
	return (event) => {
		const text = PREPARE_STAGE_TEXT[event.stage];
		if (event.type === "start") reporter.begin(event.stage, text.start);
		else reporter.end(event.stage, text.done, event.durationMs);
	};
}

/** Log de um passo concluído com a duração (usado fora do prepare). */
export function stepDone(logger: LoggerLike, message: string, startedMs: number): void {
	logger.success(`${message} (${formatDuration(Date.now() - startedMs)})`);
}
