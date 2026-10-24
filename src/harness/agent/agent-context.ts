/**
 * Contexto de um agente de revisão (um watchdog).
 */

import type { AstAnalysis, AstImpact } from "../../core/ast/types";
import type { ChangedScope } from "../../core/changed-scope";
import type { DiffSource } from "../../core/diff-source";
import type { Watchdog } from "../../core/domain/watchdog";
import type { WatchdogRenderContext } from "../../core/types";
import type { RuleAnalysis } from "../investigation/rule-analyzer";

/** Dados imutáveis entregues ao agente. */
export type AgentContext = {
	watchdog: Watchdog;
	projectName: string;
	branch: string;
	/** Arquivos do domínio (dentro do orçamento). */
	files: readonly string[];
	/** Arquivos do domínio fora do orçamento (não ler; registrar em skipped). */
	overflow: readonly string[];
	deleted: readonly string[];
	docs: readonly string[];
	context?: WatchdogRenderContext | null;
	ast: ReadonlyMap<string, AstAnalysis>;
	impact?: AstImpact;
	/** Caminho de saída do findings (staging). */
	outputPath: string;
	maxSteps: number;
	maxCalls: number;
	repoRoot: string;
	diff: DiffSource;
	/** Escopo do diff: faixas/símbolos que podem virar finding. */
	changedScope: ChangedScope;
	/** Análises determinísticas das regras do watchdog. */
	rules: readonly RuleAnalysis[];
};
