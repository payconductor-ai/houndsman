/**
 * Cliente HTTP mínimo para a API TypeSafe "System One" (Jev).
 *
 * Implementação própria sobre `axios` (sem SDK oficial) para manter o
 * pipeline de review sem dependências novas de SDK e com tipagem explícita
 * do request/response (`./jev-types`).
 *
 * Config: apenas `HOUNDSMAN_TYPE_SAFE_API_KEY` (via `core/env.ts`). Origem e
 * modelo da API são fixos no código (constantes abaixo).
 *
 * Erros são normalizados em `JevError` — o chamador decide falhar-aberto.
 */

import axios, { type AxiosInstance, isAxiosError } from "axios";
import { ENV_NAMES, env } from "../env";
import type { JevEvaluateRequest, JevEvaluateResponse } from "./jev-types";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 20_000;
/** Timeout da verificação de credencial do `doctor` (mais curto que o de review). */
const DEFAULT_PING_TIMEOUT_MS = 10_000;
/** Caminho fixo do endpoint System One. */
const JEV_PATH = "/v1/systemone";

export class JevError extends Error {
	/** Status HTTP da resposta, quando houver (indefinido em falha de rede). */
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "JevError";
		this.status = status;
	}
}

/** Resultado da verificação de credencial (`doctor`) — não lança, devolve dados. */
export type JevCredentialCheck =
	| { ok: true; model: string }
	| { ok: false; kind: "invalid" | "unreachable"; detail: string };

export type JevClientOptions = {
	/** Chave de API (default: `env.typeSafeApiKey`). */
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
		this.apiKey = options.apiKey ?? env.typeSafeApiKey;
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
			throw new JevError(`${ENV_NAMES.typeSafeApiKey} não configurada.`);
		}
		try {
			const { data } = await this.http.post<JevEvaluateResponse>(
				JEV_PATH,
				{ ...request, model: request.model ?? this.model },
				{ headers: { Authorization: `Bearer ${this.apiKey}` } },
			);
			return data;
		} catch (error) {
			const { message, status } = JevClient.parseError(error);
			throw new JevError(message, status);
		}
	}

	/**
	 * Verifica a credencial com uma chamada mínima (usada pelo `doctor`).
	 *
	 * Não lança: devolve o resultado tipado para o chamador decidir (fail-open).
	 * 2xx → válida; 401/403 → inválida; demais → indeterminada (rede/timeout).
	 */
	async validateCredential(): Promise<JevCredentialCheck> {
		if (!this.apiKey) {
			return {
				ok: false,
				kind: "unreachable",
				detail: `${ENV_NAMES.typeSafeApiKey} não configurada.`,
			};
		}
		const request: JevEvaluateRequest = {
			state: "Ping de verificação de credencial do houndsman.",
			questions: {
				ping: {
					type: "noul",
					instructions: 'A seguinte afirmação é verdadeira? "Este é um ping."',
				},
			},
		};
		try {
			const { data } = await this.http.post<JevEvaluateResponse>(
				JEV_PATH,
				{ ...request, model: this.model },
				{
					headers: { Authorization: `Bearer ${this.apiKey}` },
					timeout: DEFAULT_PING_TIMEOUT_MS,
				},
			);
			return { ok: true, model: data.model ?? this.model };
		} catch (error) {
			const { message, status } = JevClient.parseError(error);
			const kind = status === 401 || status === 403 ? "invalid" : "unreachable";
			return { ok: false, kind, detail: message };
		}
	}

	/** Normaliza o erro do axios em `{ message, status }` (sem expor o payload bruto). */
	private static parseError(error: unknown): {
		message: string;
		status?: number;
	} {
		if (isAxiosError(error)) {
			const status = error.response?.status;
			const responseData = error.response?.data;
			const detail =
				typeof responseData === "string"
					? responseData
					: responseData
						? responseData?.detail?.message || JSON.stringify(responseData)
						: error.message;
			return {
				message: status ? `HTTP ${status}: ${detail}` : detail,
				status,
			};
		}
		return {
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
