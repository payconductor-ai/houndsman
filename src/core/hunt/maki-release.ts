/**
 * Releases do maki (harness local) — resolução pura de versão, asset e checksum.
 *
 * O houndsman fixa uma versão testada (`DEFAULT_MAKI_VERSION`) e baixa o binário
 * do GitHub Releases. Nada aqui acessa rede: são funções puras para teste.
 */

import { DEFAULT_MAKI_VERSION } from "../defaults";
import { env } from "../env";

/** Repositório oficial do maki (binários por plataforma). */
export const MAKI_REPO = "tontinton/maki";

/** Base dos downloads de release. */
export const MAKI_RELEASE_BASE = `https://github.com/${MAKI_REPO}/releases/download`;

/** Asset de release para uma combinação plataforma/arquitetura. */
export type MakiAsset = {
	/** Nome do arquivo no release. */
	name: string;
	/** Formato de compressão (só informativo; a extração usa `tar`). */
	format: "tar.gz" | "zip";
};

/** Assets publicados por plataforma/arquitetura. */
const MAKI_ASSETS: Record<string, MakiAsset> = {
	"win32-x64": { name: "maki-v{version}-x86_64-pc-windows-msvc.zip", format: "zip" },
	"darwin-x64": {
		name: "maki-v{version}-x86_64-apple-darwin.tar.gz",
		format: "tar.gz",
	},
	"darwin-arm64": {
		name: "maki-v{version}-aarch64-apple-darwin.tar.gz",
		format: "tar.gz",
	},
	"linux-x64": {
		name: "maki-v{version}-x86_64-unknown-linux-musl.tar.gz",
		format: "tar.gz",
	},
	"linux-arm64": {
		name: "maki-v{version}-aarch64-unknown-linux-musl.tar.gz",
		format: "tar.gz",
	},
};

/** Nome do executável do maki na plataforma atual. */
export function makiBinaryName(platform: string = process.platform): string {
	return platform === "win32" ? "maki.exe" : "maki";
}

/** Normaliza a versão (`v0.6.5` → `0.6.5`) e valida os caracteres. */
export function normalizeMakiVersion(value: string): string {
	const normalized = value.trim().replace(/^v/i, "");
	if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(normalized)) {
		throw new Error(`Versão do maki inválida: '${value}'.`);
	}
	return normalized;
}

/** Versão efetiva: flag/env (`HOUNDSMAN_MAKI_VERSION`) ou a fixada no pacote. */
export function effectiveMakiVersion(override?: string): string {
	const value = override?.trim() || env.makiVersion || DEFAULT_MAKI_VERSION;
	return normalizeMakiVersion(value);
}

/** Asset da plataforma/arquitetura informada, ou `null` se não houver release. */
export function makiAssetFor(
	platform: string,
	arch: string,
	version: string,
): MakiAsset | null {
	const asset = MAKI_ASSETS[`${platform}-${arch}`];
	if (!asset) return null;
	return {
		name: asset.name.replace("{version}", normalizeMakiVersion(version)),
		format: asset.format,
	};
}

/** URL do asset no GitHub Releases. */
export function makiDownloadUrl(version: string, asset: string): string {
	return `${MAKI_RELEASE_BASE}/v${normalizeMakiVersion(version)}/${asset}`;
}

/** URL do arquivo de checksums do release. */
export function makiChecksumsUrl(version: string): string {
	return `${MAKI_RELEASE_BASE}/v${normalizeMakiVersion(version)}/sha256sums.txt`;
}

/** Converte o `sha256sums.txt` (`<hash>  <arquivo>`) em mapa. */
export function parseChecksums(text: string): Map<string, string> {
	const checksums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
		if (!match) continue;
		checksums.set(match[2].trim(), match[1].toLowerCase());
	}
	return checksums;
}

/** Checksum esperado de um asset (ou `undefined` se o release não listar). */
export function checksumFor(checksumsText: string, asset: string): string | undefined {
	return parseChecksums(checksumsText).get(asset);
}
