/**
 * Middleware de execução das tools.
 *
 * Cadeia: validação Zod → cache → budget → execução → limites → redaction →
 * auditoria. Toda tool passa por aqui; nenhuma executa direto.
 */

import type { ToolResult } from "./agent-tool";
import { limitText, TOOL_LIMITS } from "./result-limiter";
import { redactSecrets, redactValue } from "./secret-redactor";
import { ToolCache } from "./tool-cache";
import { ToolBudgetError } from "./tool-call-budget";
import type { ToolContext } from "./tool-context";
import type { AgentStateName } from "./tool-policy";
import type { RegisteredTool } from "./tool-registry";

/** Executor com validação, cache, budget, limite e auditoria. */
export class ToolMiddleware {
	async run(
		tool: RegisteredTool,
		input: unknown,
		context: ToolContext,
		state: AgentStateName,
	): Promise<ToolResult<unknown>> {
		const parsed = tool.inputSchema.safeParse(input);
		if (!parsed.success) {
			return {
				ok: false,
				error: `input inválido para '${tool.metadata.name}': ${parsed.error.message}`,
			};
		}

		const maxPerAgent = tool.metadata.maxCallsPerAgent;
		if (
			maxPerAgent !== undefined &&
			context.state.callsOf(tool.metadata.name) >= maxPerAgent
		) {
			return {
				ok: false,
				error: `Limite de ${maxPerAgent} chamada(s) da tool '${tool.metadata.name}'.`,
			};
		}

		const key = ToolCache.key(tool.metadata.name, parsed.data);
		const cached = context.cache.get<ToolResult<unknown>>(key);
		if (cached) return cached;

		try {
			context.budget.consume(tool.metadata.name);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof ToolBudgetError ? error.message : String(error),
			};
		}

		const started = performance.now();
		try {
			// Contravariância: a tool concreta aceita seu próprio input.
			const result = (await tool.execute(
				parsed.data as never,
				context,
			)) as ToolResult<unknown>;
			const limited = limitResult(result);
			const redacted = redactValue(limited);
			context.cache.set(key, redacted, tool.metadata.cacheTtlMs ?? 60_000);
			context.state.recordToolCall(tool.metadata.name);
			const stored = (redacted.evidence ?? []).map(
				(evidence) =>
					context.state.getEvidence(evidence.id) ??
					context.state.addEvidence(evidence),
			);
			if (stored.length > 0) redacted.evidence = stored;
			context.logger.journal.recordToolCall(
				tool.metadata.name,
				state,
				performance.now() - started,
				redacted,
			);
			return redacted;
		} catch (error) {
			const message = redactSecrets(
				error instanceof Error ? error.message : String(error),
			);
			context.logger.journal.recordToolCall(
				tool.metadata.name,
				state,
				performance.now() - started,
				{ ok: false, error: message },
			);
			return { ok: false, error: message };
		}
	}
}

/** Aplica tetos de texto ao resultado da tool. */
function limitResult(result: ToolResult<unknown>): ToolResult<unknown> {
	const copy: ToolResult<unknown> = { ...result };
	if (typeof copy.data === "string") {
		const limited = limitText(copy.data, TOOL_LIMITS.maxBytes);
		copy.data = limited.text;
		if (limited.truncated) copy.truncated = true;
	}
	return copy;
}
