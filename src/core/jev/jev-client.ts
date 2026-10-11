/**
 * Cliente HTTP mínimo para a API TypeSafe "System One" (Jev).
 *
 * Implementação própria sobre `axios` (sem SDK oficial) para manter o
 * pipeline de review sem dependências novas de SDK e com tipagem explícita
 * do request/response (`./jev-types`).
 *
 * Config: apenas `TYPESAFE_API_KEY` (via env). Origem e modelo da API são
 * fixos no código (constantes abaixo).
 *
 * Erros são normalizados em `JevError` — o chamador decide falhar-aberto.
 */

import axios, { type AxiosInstance, isAxiosError } from "axios";
import type { JevEvaluateRequest, JevEvaluateResponse } from "./jev-types";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 20_000;
/** Caminho fixo do endpoint System One. */
const JEV_PATH = "/v1/systemone";

export class JevError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevError";
	}
}

export type JevClientOptions = {
	/** Chave de API (default: `process.env.TYPESAFE_API_KEY`). */
	apiKey?: string;
	/** Sobreposição da origem da API (default: constante `DEFAULT_BASE_URL`). */
	baseURL?: string;
	/** Sobreposição do modelo (default: constante `DEFAULT_MODEL`). */
	model?: string;
	timeoutMs?: number;
	/** Instância axios injetável (testes). */
	http?: AxiosInstance;
};

export class JevClient {
	private readonly http: AxiosInstance;
	private readonly apiKey?: string;
	/** Modelo usado quando o request não informa um. */
	readonly model: string;

	constructor(options: JevClientOptions = {}) {
		this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
		this.model = options.model ?? DEFAULT_MODEL;
		const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
		this.http =
			options.http ??
			axios.create({
				baseURL,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
	}

	/** `true` se há chave configurada (sem chave o passo é pulado). */
	isConfigured(): boolean {
		return Boolean(this.apiKey);
	}

	/**
	 * Avalia as `questions` contra o `state` em uma única chamada.
	 * Lança `JevError` em falha de rede/HTTP/parse — o chamador trata.
	 */
	async evaluate(request: JevEvaluateRequest): Promise<JevEvaluateResponse> {
		if (!this.apiKey) {
			throw new JevError("TYPESAFE_API_KEY não configurada.");
		}
		try {
			const { data } = await this.http.post<JevEvaluateResponse>(
				JEV_PATH,
				{ ...request, model: request.model ?? this.model },
				{ headers: { Authorization: `Bearer ${this.apiKey}` } },
			);
			return data;
		} catch (error) {
			throw new JevError(JevClient.describeError(error));
		}
	}

	/** Normaliza o erro do axios em mensagem legível (sem expor o payload bruto). */
	private static describeError(error: unknown): string {
		if (isAxiosError(error)) {
			const status = error.response?.status;
			const detail =
				typeof error.response?.data === "string"
					? error.response.data
					: error.response?.data
						? JSON.stringify(error.response.data)
						: error.message;
			return status ? `HTTP ${status}: ${detail}` : detail;
		}
		return error instanceof Error ? error.message : String(error);
	}
}
