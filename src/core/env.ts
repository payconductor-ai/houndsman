/**
 * Variáveis de ambiente do houndsman (fonte única).
 *
 * O Bun carrega `.env` do diretório atual automaticamente; o motor lê tudo
 * daqui em vez de espalhar `process.env.*` pelo código. Chaves ausentes ou
 * vazias viram `undefined` — o chamador decide se o recurso é opcional.
 */

/**
 * Nomes canônicos das variáveis.
 *
 * Toda chave de integração do houndsman usa o prefixo `HOUNDSMAN_` — evita
 * colisão com envs do projeto consumidor. Apenas variáveis nativas do SO/CI
 * (`LOCALAPPDATA`, `XDG_DATA_HOME`, `NO_COLOR`, `TERM`, `CI`) mantêm o nome
 * global, porque são convenções do ambiente.
 */
export const ENV_NAMES = {
	typeSafeApiKey: "HOUNDSMAN_TYPE_SAFE_API_KEY",
	deepSeekApiKey: "HOUNDSMAN_DEEP_SEEK_API_KEY",
	openAiApiKey: "HOUNDSMAN_OPENAI_API_KEY",
	anthropicApiKey: "HOUNDSMAN_ANTHROPIC_API_KEY",
	makiPath: "HOUNDSMAN_MAKI_PATH",
	makiVersion: "HOUNDSMAN_MAKI_VERSION",
	home: "HOUNDSMAN_HOME",
	localAppData: "LOCALAPPDATA",
	xdgDataHome: "XDG_DATA_HOME",
	noColor: "NO_COLOR",
	term: "TERM",
	ci: "CI",
} as const;

/** Snapshot tipado do ambiente (sem expor segredos). */
export type HoundsmanEnv = {
	typeSafeApiKey?: string;
	deepSeekApiKey?: string;
	openAiApiKey?: string;
	anthropicApiKey?: string;
	/** Caminho explícito do binário do maki (harness local `hunt`). */
	makiPath?: string;
	/** Versão do maki a instalar (default: a fixada pelo pacote). */
	makiVersion?: string;
	home?: string;
	localAppData?: string;
	xdgDataHome?: string;
	noColor?: string;
	term?: string;
	ci?: string;
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
		openAiApiKey: read(ENV_NAMES.openAiApiKey),
		anthropicApiKey: read(ENV_NAMES.anthropicApiKey),
		makiPath: read(ENV_NAMES.makiPath),
		makiVersion: read(ENV_NAMES.makiVersion),
		home: read(ENV_NAMES.home),
		localAppData: read(ENV_NAMES.localAppData),
		xdgDataHome: read(ENV_NAMES.xdgDataHome),
		noColor: read(ENV_NAMES.noColor),
		term: read(ENV_NAMES.term),
		ci: read(ENV_NAMES.ci),
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
	get openAiApiKey(): string | undefined {
		return read(ENV_NAMES.openAiApiKey);
	},
	get anthropicApiKey(): string | undefined {
		return read(ENV_NAMES.anthropicApiKey);
	},
	get makiPath(): string | undefined {
		return read(ENV_NAMES.makiPath);
	},
	get makiVersion(): string | undefined {
		return read(ENV_NAMES.makiVersion);
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
	get noColor(): string | undefined {
		return read(ENV_NAMES.noColor);
	},
	get term(): string | undefined {
		return read(ENV_NAMES.term);
	},
	get ci(): string | undefined {
		return read(ENV_NAMES.ci);
	},
} as const;
