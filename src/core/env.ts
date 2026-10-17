/**
 * Variáveis de ambiente do houndsman (fonte única).
 *
 * O Bun carrega `.env` do diretório atual automaticamente; o motor lê tudo
 * daqui em vez de espalhar `process.env.*` pelo código. Chaves ausentes ou
 * vazias viram `undefined` — o chamador decide se o recurso é opcional.
 */

/** Nomes canônicos das variáveis. */
export const ENV_NAMES = {
	typeSafeApiKey: "HOUNDSMAN_TYPE_SAFE_API_KEY",
	deepSeekApiKey: "HOUNDSMAN_DEEP_SEEK_API_KEY",
	home: "HOUNDSMAN_HOME",
	localAppData: "LOCALAPPDATA",
	xdgDataHome: "XDG_DATA_HOME",
} as const;

/** Snapshot tipado do ambiente (sem expor segredos). */
export type HoundsmanEnv = {
	typeSafeApiKey?: string;
	deepSeekApiKey?: string;
	home?: string;
	localAppData?: string;
	xdgDataHome?: string;
};

/** Lê uma variável, apara espaços e trata vazio como ausente. */
function read(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value && value.length > 0 ? value : undefined;
}

/** Snapshot do ambiente no momento da chamada. */
export function readEnv(): HoundsmanEnv {
	return {
		typeSafeApiKey: read(ENV_NAMES.typeSafeApiKey),
		deepSeekApiKey: read(ENV_NAMES.deepSeekApiKey),
		home: read(ENV_NAMES.home),
		localAppData: read(ENV_NAMES.localAppData),
		xdgDataHome: read(ENV_NAMES.xdgDataHome),
	};
}

/**
 * Acesso sob demanda. Getter (em vez de constante congelada) mantém testes e
 * processos que alteram o ambiente em runtime funcionando.
 */
export const env = {
	get typeSafeApiKey(): string | undefined {
		return read(ENV_NAMES.typeSafeApiKey);
	},
	get deepSeekApiKey(): string | undefined {
		return read(ENV_NAMES.deepSeekApiKey);
	},
	get home(): string | undefined {
		return read(ENV_NAMES.home);
	},
	get localAppData(): string | undefined {
		return read(ENV_NAMES.localAppData);
	},
	get xdgDataHome(): string | undefined {
		return read(ENV_NAMES.xdgDataHome);
	},
} as const;
