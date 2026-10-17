/**
 * Contrato das tools do harness nativo.
 *
 * Cada tool declara metadados (categoria, capabilities, custo, cache, limite) e
 * um schema Zod. É read-only por construção: não executa shell arbitrário, não
 * escreve arquivos e não acessa a rede.
 */

import type { ZodType, ZodTypeAny } from "zod";
import type { AstService } from "../../core/ast/service";
import type { DiffSource } from "../../core/diff-source";
import type { Watchdog } from "../../core/domain/watchdog";
import type { AgentContext } from "../agent/agent-context";
import type { AgentReporter } from "../agent/agent-reporter";
import type { AgentState } from "../investigation/agent-state";
import type { Evidence } from "../investigation/evidence";
import type { RuleAnalysis } from "../investigation/rule-analyzer";
import type { ToolCache } from "./tool-cache";
import type { ToolCallBudget } from "./tool-call-budget";

/** Categoria de agrupamento (usada no prompt e na policy). */
export type ToolCategory = "context" | "code" | "symbol" | "ast" | "rules" | "evidence";

/** Capability declarada por uma tool (a policy libera por capability). */
export type ToolCapability =
	| "read"
	| "search"
	| "outline"
	| "symbol"
	| "references"
	| "ast"
	| "impact"
	| "rules"
	| "tests"
	| "docs";

/** Metadados estáveis (o prompt é gerado a partir daqui). */
export type ToolMetadata = {
	name: string;
	description: string;
	category: ToolCategory;
	capabilities: readonly ToolCapability[];
	readOnly: true;
	/** Custo relativo para o planner (1 = barato, 5 = caro). */
	cost: 1 | 2 | 3 | 4 | 5;
	cacheTtlMs?: number;
	maxCallsPerAgent?: number;
};

/** Resultado de uma tool (sempre estruturado). */
export type ToolResult<T = unknown> = {
	ok: boolean;
	data?: T;
	evidence?: Evidence[];
	truncated?: boolean;
	hint?: string;
	error?: string;
};

/** Contexto de execução de uma tool. */
export type ToolContext = {
	repoRoot: string;
	watchdog: Watchdog;
	diff: DiffSource;
	ast: AstService;
	state: AgentState;
	budget: ToolCallBudget;
	cache: ToolCache;
	logger: AgentReporter;
	agent: AgentContext;
	/** Análises determinísticas das regras do watchdog (por texto). */
	rules: ReadonlyMap<string, RuleAnalysis>;
};

/** Tool executável por um agente. */
export interface AgentTool<I = unknown, O = unknown> {
	readonly metadata: ToolMetadata;
	readonly inputSchema: ZodType<I>;
	execute(input: I, context: ToolContext): Promise<ToolResult<O>>;
}

/** Módulo de registro de tools (permite agrupar por domínio). */
export interface ToolModule {
	register(registry: ToolRegistryLike): void;
}

/**
 * Forma aceita pelo registry. `execute(input: never)` aceita qualquer tool
 * concreta por contravariância, sem apelar para `any`.
 */
export type RegisterableTool = {
	readonly metadata: ToolMetadata;
	readonly inputSchema: ZodTypeAny;
	execute(input: never, context: ToolContext): Promise<ToolResult<unknown>>;
};

/** Superfície mínima de registro (evita dependência circular com a classe). */
export interface ToolRegistryLike {
	registerTool(tool: RegisterableTool): void;
}

export type { ZodTypeAny };
