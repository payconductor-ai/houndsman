/**
 * Instalação e descoberta do binário do maki (harness local).
 *
 * O binário é opcional e fica fora do projeto: `<HOUNDSMAN_HOME>/tools/maki`.
 * `houndsman hunt install` baixa o release fixado e verifica o sha256; o
 * `houndsman update`/`setup` nunca toca nisso. A skill `/houndsman hunt`
 * (harness externo) não usa este módulo.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "../env";
import { displayPath } from "../paths";
import { systemClock } from "../services/clock";
import { houndsmanHome } from "../storage/paths";
import {
	checksumFor,
	effectiveMakiVersion,
	makiAssetFor,
	makiBinaryName,
	makiChecksumsUrl,
	makiDownloadUrl,
	normalizeMakiVersion,
} from "./maki-release";

/** Origem do binário resolvido. */
export type MakiBinarySource = "env" | "config" | "managed" | "path";

/** Binário do maki disponível para execução. */
export type MakiBinary = {
	path: string;
	source: MakiBinarySource;
	/** Versão conhecida (instalação gerenciada). */
	version?: string;
};

/** Manifesto da instalação gerenciada (`current.json`). */
export type MakiInstallManifest = {
	version: string;
	path: string;
	asset?: string;
	sha256?: string;
	installedAt: string;
};

/** Raiz das versões gerenciadas do maki. */
export function makiToolsRoot(): string {
	return join(houndsmanHome(), "tools", "maki");
}

/** Diretório de uma versão instalada. */
export function makiInstallDir(version: string): string {
	return join(makiToolsRoot(), normalizeMakiVersion(version));
}

/** Caminho do ponteiro para a instalação ativa. */
export function makiCurrentFile(): string {
	return join(makiToolsRoot(), "current.json");
}

/** Lê o manifesto da instalação gerenciada (null se ausente/inválido). */
export function readMakiInstall(): MakiInstallManifest | null {
	const file = makiCurrentFile();
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(
			readFileSync(file, "utf8"),
		) as Partial<MakiInstallManifest>;
		if (typeof parsed.version !== "string" || typeof parsed.path !== "string") {
			return null;
		}
		return {
			version: parsed.version,
			path: parsed.path,
			asset: parsed.asset,
			sha256: parsed.sha256,
			installedAt: parsed.installedAt ?? systemClock(),
		};
	} catch {
		return null;
	}
}

/** Grava o ponteiro da instalação ativa. */
function writeInstallManifest(manifest: MakiInstallManifest): void {
	const file = makiCurrentFile();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Resolve o binário: `HOUNDSMAN_MAKI_PATH` > `hunt.binaryPath` > instalação
 * gerenciada > `maki` no PATH. Não valida existência (use `requireMakiBinary`).
 */
export function resolveMakiBinary(configPath?: string): MakiBinary | null {
	const explicit = env.makiPath ?? configPath?.trim();
	if (explicit && explicit.length > 0) {
		return { path: resolve(explicit), source: env.makiPath ? "env" : "config" };
	}
	const managed = readMakiInstall();
	if (managed)
		return { path: managed.path, source: "managed", version: managed.version };
	const which = Bun.which("maki");
	if (which) return { path: which, source: "path" };
	return null;
}

/** Rótulo legível da origem (diagnóstico). */
export function makiSourceLabel(source: MakiBinarySource): string {
	switch (source) {
		case "env":
			return "HOUNDSMAN_MAKI_PATH";
		case "config":
			return "hunt.binaryPath";
		case "managed":
			return "instalação gerenciada";
		default:
			return "PATH";
	}
}

/** Resolve e exige um binário existente; lança erro acionável quando ausente. */
export function requireMakiBinary(configPath?: string): MakiBinary {
	const binary = resolveMakiBinary(configPath);
	if (!binary) {
		throw new Error(
			"Capability `hunt` não instalada: rode `houndsman hunt install` (ou defina HOUNDSMAN_MAKI_PATH).",
		);
	}
	if (!existsSync(binary.path)) {
		throw new Error(
			`Binário do maki não encontrado em ${displayPath(binary.path)} (${makiSourceLabel(binary.source)}). ` +
				"Rode `houndsman hunt install --force` ou ajuste HOUNDSMAN_MAKI_PATH.",
		);
	}
	return binary;
}

/** Lê a versão do binário (`maki --version`); `undefined` se indisponível. */
export function probeMakiVersion(binaryPath: string): string | undefined {
	try {
		const result = Bun.spawnSync([binaryPath, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return undefined;
		const output = result.stdout.toString().trim();
		return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
	} catch {
		return undefined;
	}
}

/** Opções de instalação. */
export type InstallMakiOptions = {
	/** Versão alvo (`vX.Y.Z` ou `X.Y.Z`). */
	version?: string;
	/** Reinstala mesmo se o binário já existir. */
	force?: boolean;
	/** Arquivo local (`.tar.gz`/`.zip`) para ambientes offline. */
	from?: string;
	/** Progresso textual (CLI). */
	log?: (message: string) => void;
	/** `fetch` injetável (testes). */
	fetchImpl?: typeof fetch;
};

/** Resultado da instalação. */
export type InstallMakiResult = {
	version: string;
	path: string;
	skipped: boolean;
};

/** Baixa (ou extrai) o maki para `<HOUNDSMAN_HOME>/tools/maki/<versão>`. */
export async function installMaki(
	options: InstallMakiOptions = {},
): Promise<InstallMakiResult> {
	const version = effectiveMakiVersion(options.version);
	const binaryName = makiBinaryName();
	const target = join(makiInstallDir(version), binaryName);
	const log = options.log ?? (() => {});

	if (existsSync(target) && !options.force) {
		writeInstallManifest({ version, path: target, installedAt: systemClock() });
		return { version, path: target, skipped: true };
	}

	const asset = makiAssetFor(process.platform, process.arch, version);
	if (!asset) {
		throw new Error(
			`Sem release do maki para ${process.platform}/${process.arch}. ` +
				"Instale manualmente (https://github.com/tontinton/maki/releases) e defina HOUNDSMAN_MAKI_PATH.",
		);
	}

	const temp = mkdtempSync(join(tmpdir(), "houndsman-maki-"));
	try {
		let archivePath: string;
		let checksum: string | undefined;

		if (options.from) {
			archivePath = resolve(options.from);
			if (!existsSync(archivePath)) {
				throw new Error(
					`Arquivo do maki não encontrado: ${displayPath(archivePath)}.`,
				);
			}
			log(`Extraindo ${displayPath(archivePath)}...`);
		} else {
			const fetchImpl = options.fetchImpl ?? fetch;
			const url = makiDownloadUrl(version, asset.name);
			log(`Baixando maki v${version} (${asset.name})...`);
			const response = await fetchImpl(url);
			if (!response.ok) {
				throw new Error(
					`Falha ao baixar o maki (HTTP ${response.status}): ${url}`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());

			const checksumsResponse = await fetchImpl(makiChecksumsUrl(version));
			if (checksumsResponse.ok) {
				const expected = checksumFor(await checksumsResponse.text(), asset.name);
				if (expected) {
					const actual = createHash("sha256").update(bytes).digest("hex");
					if (actual !== expected) {
						throw new Error(
							`Checksum inválido para ${asset.name} (esperado ${expected.slice(0, 12)}…, obtido ${actual.slice(0, 12)}…).`,
						);
					}
					checksum = expected;
					log("Checksum sha256 verificado.");
				} else {
					log(
						"Aviso: release sem checksum para o asset; seguindo sem verificação.",
					);
				}
			} else {
				log(
					`Aviso: não foi possível obter sha256sums.txt (HTTP ${checksumsResponse.status}).`,
				);
			}

			archivePath = join(temp, asset.name);
			writeFileSync(archivePath, bytes);
		}

		const extractDir = join(temp, "extract");
		mkdirSync(extractDir, { recursive: true });
		extractArchive(archivePath, extractDir);
		const found = findFile(extractDir, binaryName);
		if (!found) {
			throw new Error(
				`O pacote do maki não contém '${binaryName}'. Conteúdo inesperado em ${basename(archivePath)}.`,
			);
		}

		const installDir = makiInstallDir(version);
		mkdirSync(installDir, { recursive: true });
		copyFileSync(found, target);
		chmodSync(target, 0o755);
		writeInstallManifest({
			version,
			path: target,
			asset: asset.name,
			sha256: checksum,
			installedAt: systemClock(),
		});
		return { version, path: target, skipped: false };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

/** Remove todas as versões gerenciadas; devolve o caminho removido (ou null). */
export function uninstallMaki(): string | null {
	const root = makiToolsRoot();
	if (!existsSync(root)) return null;
	rmSync(root, { recursive: true, force: true });
	return root;
}

/** Extrai `.tar.gz`/`.zip` (Windows usa o `tar.exe`/bsdtar do sistema). */
function extractArchive(archive: string, directory: string): void {
	try {
		const result = Bun.spawnSync(["tar", "-xf", archive, "-C", directory], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			const detail = result.stderr.toString().trim();
			throw new Error(
				`Falha ao extrair ${basename(archive)}${detail ? `: ${detail}` : "."}`,
			);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Falha ao extrair")) {
			throw error;
		}
		throw new Error(
			`Falha ao extrair ${basename(archive)}: 'tar' indisponível no sistema.`,
		);
	}
}

/** Procura um arquivo por nome, com profundidade limitada. */
function findFile(root: string, name: string, depth = 0): string | null {
	if (depth > 4) return null;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const found = findFile(full, name, depth + 1);
			if (found) return found;
		}
	}
	return null;
}
