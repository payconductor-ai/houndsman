/**
 * Registro das tools do harness.
 *
 * Módulos registram tools; nomes duplicados falham no startup. O registry gera
 * as descrições do prompt a partir do metadata (nunca hardcoded).
 */

import type { AiTool } from "../../core/ai";
import type {
	RegisterableTool,
	ToolContext,
	ToolMetadata,
	ToolModule,
	ToolRegistryLike,
	ToolResult,
} from "./agent-tool";
import type { ToolMiddleware } from "./tool-middleware";
import type { AgentStateName, ToolPolicy } from "./tool-policy";

/** Tool registrada, com a forma type-erased aceita pelo middleware. */
export type RegisteredTool = RegisterableTool;

/** Registry de tools. */
export class ToolRegistry implements ToolRegistryLike {
	private readonly tools = new Map<string, RegisteredTool>();

	/** Registra uma tool; nome duplicado é erro de configuração. */
	registerTool(tool: RegisterableTool): void {
		if (this.tools.has(tool.metadata.name)) {
			throw new Error(`Tool duplicada: '${tool.metadata.name}'.`);
		}
		this.tools.set(tool.metadata.name, tool);
	}

	/** Registra um módulo (agrupa tools). */
	registerModule(module: ToolModule): void {
		module.register(this);
	}

	/** Tool por nome. */
	get(name: string): RegisteredTool | undefined {
		return this.tools.get(name);
	}

	/** Todas as tools (ordem de registro). */
	list(): RegisteredTool[] {
		return [...this.tools.values()];
	}

	/** Tools com uma capability. */
	listByCapability(capability: string): RegisteredTool[] {
		return this.list().filter((tool) =>
			(tool.metadata.capabilities as readonly string[]).includes(capability),
		);
	}

	/** Descrição compacta das tools permitidas (para o prompt). */
	describeForPrompt(policy: ToolPolicy, state: AgentStateName): string {
		return this.list()
			.filter((tool) => policy.allows(state, tool.metadata))
			.map(
				(tool) =>
					`- ${tool.metadata.name} (${tool.metadata.capabilities.join(", ")}): ${tool.metadata.description}`,
			)
			.join("\n");
	}

	/** Converte as tools permitidas no formato do modelo. */
	toModelTools(
		policy: ToolPolicy,
		state: AgentStateName,
		context: ToolContext,
		middleware: ToolMiddleware,
	): Record<string, AiTool> {
		const entries = this.list()
			.filter((tool) => policy.allows(state, tool.metadata))
			.map((tool) => [
				tool.metadata.name,
				{
					name: tool.metadata.name,
					description: tool.metadata.description,
					inputSchema: tool.inputSchema,
					execute: async (input: unknown): Promise<string> => {
						const result = await middleware.run(tool, input, context, state);
						return JSON.stringify(result);
					},
				},
			]);
		return Object.fromEntries(entries);
	}

	/** Metadados registrados. */
	metadata(): ToolMetadata[] {
		return this.list().map((tool) => tool.metadata);
	}

	/** Executa uma tool com middleware (usado nos testes). */
	execute(
		name: string,
		input: unknown,
		context: ToolContext,
		middleware: ToolMiddleware,
		state: AgentStateName = "INVESTIGATE",
	): Promise<ToolResult<unknown>> {
		const tool = this.tools.get(name);
		if (!tool)
			return Promise.resolve({ ok: false, error: `tool desconhecida: ${name}` });
		return middleware.run(tool, input, context, state) as Promise<
			ToolResult<unknown>
		>;
	}
}
