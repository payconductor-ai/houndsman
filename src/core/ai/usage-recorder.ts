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

/** Formato persistido em `ai-usage.json`. */
export type AiUsageFile = {
	provider: string;
	model: string;
	total: AiUsage;
	entries: AiUsageEntry[];
};

/** Acumulador de uso (em memória) com persistência opcional. */
export class AiUsageRecorder {
	private readonly entries: AiUsageEntry[] = [];
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

	/** Total agregado de todas as chamadas. */
	get total(): AiUsage {
		return this.entries.reduce(
			(acc, entry) => addUsage(acc, entry.usage),
			emptyUsage(),
		);
	}

	/** Snapshot serializável. */
	toJSON(): AiUsageFile {
		return {
			provider: this.provider,
			model: this.model,
			total: this.total,
			entries: [...this.entries],
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
