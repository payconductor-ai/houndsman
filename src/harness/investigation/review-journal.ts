/**
 * Diário da investigação (`harness-transcript.json`).
 *
 * Registra estados, chamadas de tool, evidências, decisões do crítico e
 * truncamentos — sem prompt, resposta ou segredo.
 */

import type { ToolResult } from "../tools/tool-result";

/** Registro de uma chamada de tool. */
export type ToolCallRecord = {
	tool: string;
	state: string;
	durationMs: number;
	ok: boolean;
	truncated: boolean;
	error?: string;
};

/** Transição de estado do agente. */
export type StateTransition = {
	from: string;
	to: string;
	at: string;
};

/** Diário de um agente. */
export class ReviewJournal {
	readonly toolCalls: ToolCallRecord[] = [];
	readonly transitions: StateTransition[] = [];
	readonly notes: string[] = [];
	private readonly startedAt = Date.now();

	/** Registra uma chamada concluída. */
	recordToolCall(
		tool: string,
		state: string,
		durationMs: number,
		result: ToolResult<unknown>,
	): void {
		this.toolCalls.push({
			tool,
			state,
			durationMs: Math.round(durationMs),
			ok: result.ok,
			truncated: result.truncated === true,
			...(result.error ? { error: result.error } : {}),
		});
	}

	/** Registra uma transição de estado. */
	transition(from: string, to: string): void {
		this.transitions.push({ from, to, at: new Date().toISOString() });
	}

	/** Nota livre (hipótese, decisão, motivo de skip). */
	note(message: string): void {
		this.notes.push(message);
	}

	/** Métricas agregadas por tool. */
	metrics(): Record<string, { calls: number; errors: number; durationMs: number }> {
		const metrics: Record<
			string,
			{ calls: number; errors: number; durationMs: number }
		> = {};
		for (const call of this.toolCalls) {
			const entry = metrics[call.tool] ?? { calls: 0, errors: 0, durationMs: 0 };
			entry.calls++;
			if (!call.ok) entry.errors++;
			entry.durationMs += call.durationMs;
			metrics[call.tool] = entry;
		}
		return metrics;
	}

	/** Snapshot serializável. */
	toJSON(): Record<string, unknown> {
		return {
			elapsedMs: Date.now() - this.startedAt,
			toolCalls: this.toolCalls,
			transitions: this.transitions,
			notes: this.notes,
			metrics: this.metrics(),
		};
	}
}
