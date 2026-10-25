/**
 * Registro de uso de IA por review (`ai-usage.json`).
 *
 * Guarda uma entrada por chamada (feature, modelo, uso) e o total agregado.
 * Nunca grava prompt, resposta ou segredo.
 */

import { systemClock } from "../services/clock";
import type { StorageProvider } from "../storage/types";
import { type AiUsage, addUsage, emptyUsage } from "./types";

/** Entrada de uso de uma chamada. */
export type AiUsageEntry = {
	feature: string;
	model: string;
	at: string;
	usage: AiUsage;
};

/** Chamada que falhou (timeout, truncamento, schema) — não consome tokens. */
export type AiFailureEntry = {
	feature: string;
	model: string;
	at: string;
	durationMs: number;
	finishReason?: string;
	error: string;
};

/** Uso agregado + tentativas/falhas (vai para `prepare-report.json`). */
export type AiUsageSummary = AiUsage & {
	attempts: number;
	failures: AiFailureEntry[];
};

/** Formato persistido em `ai-usage.json`. */
export type AiUsageFile = {
	provider: string;
	model: string;
	total: AiUsage;
	attempts: number;
	entries: AiUsageEntry[];
	failures: AiFailureEntry[];
};

/** Acumulador de uso (em memória) com persistência opcional. */
export class AiUsageRecorder {
	private readonly entries: AiUsageEntry[] = [];
	private readonly failed: AiFailureEntry[] = [];
	private readonly provider: string;
	private readonly model: string;

	constructor(provider = "unknown", model = "unknown") {
		this.provider = provider;
		this.model = model;
	}

	/** Registra uma chamada concluída. */
	record(feature: string, model: string, usage: AiUsage): void {
		this.entries.push({ feature, model, at: systemClock(), usage: { ...usage } });
	}

	/** Registra uma tentativa que falhou (fail-open: nunca derruba a revisão). */
	recordFailure(
		feature: string,
		model: string,
		detail: { durationMs: number; error: string; finishReason?: string },
	): void {
		this.failed.push({
			feature,
			model,
			at: systemClock(),
			durationMs: detail.durationMs,
			error: detail.error,
			...(detail.finishReason ? { finishReason: detail.finishReason } : {}),
		});
	}

	/** Total agregado de todas as chamadas concluídas. */
	get total(): AiUsage {
		return this.entries.reduce(
			(acc, entry) => addUsage(acc, entry.usage),
			emptyUsage(),
		);
	}

	/** Tentativas (sucesso + falha) — a métrica honesta de custo/latência. */
	get attempts(): number {
		return this.entries.length + this.failed.length;
	}

	/** Falhas registradas, na ordem em que ocorreram. */
	get failures(): readonly AiFailureEntry[] {
		return this.failed;
	}

	/** Resumo para o `prepare-report.json`. */
	get summary(): AiUsageSummary {
		return { ...this.total, attempts: this.attempts, failures: [...this.failed] };
	}

	/** Snapshot serializável. */
	toJSON(): AiUsageFile {
		return {
			provider: this.provider,
			model: this.model,
			total: this.total,
			attempts: this.attempts,
			entries: [...this.entries],
			failures: [...this.failed],
		};
	}

	/** Serializa para o artefato. */
	serialize(): string {
		return `${JSON.stringify(this.toJSON(), null, 2)}\n`;
	}

	/** Persiste `ai-usage.json` no storage (fail-open). */
	write(storage: StorageProvider, reviewId: string): void {
		try {
			storage.writeArtifact(reviewId, {
				name: "ai-usage.json",
				kind: "ai-usage",
				content: this.serialize(),
			});
		} catch {
			// Observer: nunca derruba a revisão.
		}
	}
}
