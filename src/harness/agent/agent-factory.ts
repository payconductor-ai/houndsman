/**
 * Factory de agentes — injeta provider, tools e limites resolvidos.
 */

import type { ModelProvider } from "../../core/ai";
import type { AstService } from "../../core/ast/service";
import type { HarnessConfig } from "../config/harness-config";
import type { ToolPolicy } from "../tools/tool-policy";
import type { ToolRegistry } from "../tools/tool-registry";
import type { AgentContext } from "./agent-context";
import type { AgentReporter } from "./agent-reporter";
import { ReviewAgent } from "./review-agent";

/** Dependências compartilhadas por todos os agentes. */
export type AgentFactoryDeps = {
	provider: ModelProvider;
	registry: ToolRegistry;
	policy?: ToolPolicy;
	reporter: AgentReporter;
	config: HarnessConfig;
	ast: AstService;
	readFile?: (path: string) => string | null;
};

/** Cria `ReviewAgent`s a partir do contexto de cada watchdog. */
export class AgentFactory {
	constructor(private readonly deps: AgentFactoryDeps) {}

	/** Instancia um agente para o contexto. */
	create(context: AgentContext): ReviewAgent {
		const { config } = this.deps;
		return new ReviewAgent({
			context,
			provider: this.deps.provider,
			registry: this.deps.registry,
			policy: this.deps.policy,
			reporter: this.deps.reporter,
			maxOutputTokens: config.maxOutputTokensFor(context.watchdog.id),
			temperature: config.temperature,
			providerOptions: config.providerOptions,
			timeoutMs: config.timeoutMs,
			ast: this.deps.ast,
			readFile: this.deps.readFile,
		});
	}
}
