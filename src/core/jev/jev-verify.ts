/**
 * Confirmação Jev dos findings ambíguos (tier 1 do `findings verify`).
 *
 * Por arquivo: monta um `state` pequeno (topo do arquivo + diff focado
 * `foundAtSha..head`) e, numa única chamada, pergunta se cada violação ainda
 * ocorre. **Falha-aberto** — sem chave/erro, nada é confirmado: o tier local
 * decide. O custo é uma chamada por arquivo ambíguo, não uma revisão completa.
 */

import { ENV_NAMES } from "../env";
import { diffPatch, readFileAt } from "../git-revision";
import type { JevClient } from "./jev-client";
import type { JevAnswer, JevQuestion } from "./jev-types";

/** Caso ambíguo a confirmar com o Jev. */
export type JevVerifyCase = {
	id: string;
	file: string;
	rule: string;
	/** Commit em que o achado foi observado (base do diff focado). */
	foundAtSha?: string;
};

export type JevVerifyOptions = {
	/** Commit atual (head) para o diff focado. */
	headSha?: string;
	/** Nº de arquivos avaliados em paralelo. */
	concurrency?: number;
};

export type JevVerifyOutcome = {
	/** id → confiança (0–1) de a violação ainda ocorrer. */
	confidence: Map<string, number>;
	checked: number;
	skipped: number;
	reason?: string;
};

/** Linhas iniciais do arquivo incluídas no `state` (contexto de imports). */
const HEADER_LINES = 60;
const MAX_STATE_CHARS = 8_000;
const MAX_DIFF_CHARS = 4_000;
const DEFAULT_CONCURRENCY = 5;

/** Início do diff do grupo: o `foundAtSha` mais antigo informado. */
function referenceOf(
	group: readonly JevVerifyCase[],
	headSha: string | undefined,
): { from: string; to: string } | null {
	const from = group.find((item) => item.foundAtSha)?.foundAtSha;
	if (!from || !headSha || from === headSha) return null;
	return { from, to: headSha };
}

/** Arquivo → casos daquele arquivo (uma chamada por arquivo). */
function groupByFile(cases: readonly JevVerifyCase[]): Map<string, JevVerifyCase[]> {
	const map = new Map<string, JevVerifyCase[]>();
	for (const item of cases) {
		const list = map.get(item.file);
		if (list) list.push(item);
		else map.set(item.file, [item]);
	}
	return map;
}

/** Executa `fn` sobre `items` com concorrência limitada (ordem irrelevante). */
async function mapWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const current = items[cursor++];
			await fn(current);
		}
	});
	await Promise.all(workers);
}

/** Confirma com o Jev se as violações ambíguas ainda ocorrem. */
export class JevVerifier {
	private readonly client: JevClient;

	/** Construtor que recebe o cliente (injeção). */
	constructor(client: JevClient) {
		this.client = client;
	}

	/** `true` se há chave configurada (sem chave o tier 1 é pulado). */
	isConfigured(): boolean {
		return this.client.isConfigured();
	}

	/** Avalia os casos ambíguos e devolve a confiança por id. */
	async verify(
		cases: readonly JevVerifyCase[],
		options: JevVerifyOptions = {},
	): Promise<JevVerifyOutcome> {
		const confidence = new Map<string, number>();
		if (cases.length === 0) return { confidence, checked: 0, skipped: 0 };
		if (!this.client.isConfigured()) {
			return {
				confidence,
				checked: 0,
				skipped: cases.length,
				reason: `${ENV_NAMES.typeSafeApiKey} não configurada`,
			};
		}

		const groups = [...groupByFile(cases).values()];
		const jobs = groups.filter((group) => referenceOf(group, options.headSha));
		const withoutRef =
			cases.length - jobs.reduce((sum, group) => sum + group.length, 0);
		let skipped = withoutRef;

		await mapWithConcurrency(
			jobs,
			options.concurrency ?? DEFAULT_CONCURRENCY,
			async (group) => {
				try {
					const answers = await this.evaluateGroup(group, options.headSha);
					for (const item of group) {
						const answer = answers[item.id];
						if (answer?.type === "noul") confidence.set(item.id, answer.noul);
					}
				} catch {
					skipped += group.length;
				}
			},
		);

		return {
			confidence,
			checked: confidence.size,
			skipped,
			reason:
				withoutRef > 0
					? "sem commit de referência (foundAtSha) em algum arquivo"
					: undefined,
		};
	}

	/** Uma chamada por arquivo: `state` focado + uma pergunta por caso. */
	private async evaluateGroup(
		group: readonly JevVerifyCase[],
		headSha: string | undefined,
	): Promise<Record<string, JevAnswer>> {
		const reference = referenceOf(group, headSha);
		if (!reference) throw new Error("sem commit de referência para o diff focado.");

		const file = group[0].file;
		const patch =
			diffPatch(`${reference.from}..${reference.to}`, [file]).get(file) ?? "";
		const header = (readFileAt(reference.to, file) ?? "")
			.split("\n")
			.slice(0, HEADER_LINES)
			.join("\n");

		const parts = [`Arquivo: ${file}`];
		if (header) parts.push("--- topo do arquivo ---", header);
		if (patch) {
			parts.push("--- diff desde a revisão ---", patch.slice(0, MAX_DIFF_CHARS));
		}
		const state = parts.join("\n").slice(0, MAX_STATE_CHARS);

		const questions: Record<string, JevQuestion> = {};
		for (const item of group) {
			questions[item.id] = {
				type: "noul",
				instructions: `No estado fornecido, a violação a seguir ainda ocorre? "${item.rule}"`,
			};
		}

		const response = await this.client.evaluate({ state, questions });
		return response.answers;
	}
}
