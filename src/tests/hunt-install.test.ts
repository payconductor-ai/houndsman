/**
 * Instalação local do maki (sem rede).
 *
 * Valida a resolução de asset/versão/checksum e a instalação a partir de um
 * arquivo local (`--from`), além do ponteiro gerenciado e do uninstall.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installMaki,
	makiCurrentFile,
	makiInstallDir,
	makiSourceLabel,
	readMakiInstall,
	resolveMakiBinary,
	uninstallMaki,
} from "../core/hunt/maki-install";
import {
	effectiveMakiVersion,
	makiAssetFor,
	makiBinaryName,
	makiChecksumsUrl,
	makiDownloadUrl,
	parseChecksums,
} from "../core/hunt/maki-release";

const original = {
	home: process.env.HOUNDSMAN_HOME,
	makiPath: process.env.HOUNDSMAN_MAKI_PATH,
	makiVersion: process.env.HOUNDSMAN_MAKI_VERSION,
};
const dirs: string[] = [];

afterEach(() => {
	restoreEnv("HOUNDSMAN_HOME", original.home);
	restoreEnv("HOUNDSMAN_MAKI_PATH", original.makiPath);
	restoreEnv("HOUNDSMAN_MAKI_VERSION", original.makiVersion);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

describe("maki-release", () => {
	test("resolve asset por plataforma/arquitetura", () => {
		expect(makiAssetFor("win32", "x64", "0.6.5")?.name).toBe(
			"maki-v0.6.5-x86_64-pc-windows-msvc.zip",
		);
		expect(makiAssetFor("darwin", "arm64", "v0.6.5")?.name).toBe(
			"maki-v0.6.5-aarch64-apple-darwin.tar.gz",
		);
		expect(makiAssetFor("linux", "x64", "0.6.5")?.name).toBe(
			"maki-v0.6.5-x86_64-unknown-linux-musl.tar.gz",
		);
		expect(makiAssetFor("solaris", "x64", "0.6.5")).toBeNull();
	});

	test("versão normaliza v e aceita override por env", () => {
		expect(effectiveMakiVersion("v1.2.3")).toBe("1.2.3");
		process.env.HOUNDSMAN_MAKI_VERSION = "v2.0.0";
		expect(effectiveMakiVersion()).toBe("2.0.0");
		expect(() => effectiveMakiVersion("../../x")).toThrow("Versão do maki inválida");
	});

	test("URLs e parse de sha256sums", () => {
		expect(makiDownloadUrl("0.6.5", "maki.tar.gz")).toContain(
			"/releases/download/v0.6.5/maki.tar.gz",
		);
		expect(makiChecksumsUrl("0.6.5").endsWith("/v0.6.5/sha256sums.txt")).toBe(true);
		const checksums = parseChecksums(
			[
				`${"a".repeat(64)}  maki-a.tar.gz`,
				`${"b".repeat(64)} *maki-b.zip`,
				"linha inválida",
			].join("\n"),
		);
		expect(checksums.get("maki-a.tar.gz")).toBe("a".repeat(64));
		expect(checksums.get("maki-b.zip")).toBe("b".repeat(64));
	});
});

describe("resolução do binário", () => {
	test("HOUNDSMAN_MAKI_PATH tem precedência", () => {
		const root = tempDir("houndsman-maki-resolve-");
		const binary = join(root, "maki-custom");
		writeFileSync(binary, "fake");
		process.env.HOUNDSMAN_MAKI_PATH = binary;
		const resolved = resolveMakiBinary();
		expect(resolved?.path).toBe(binary);
		expect(resolved?.source).toBe("env");
		expect(makiSourceLabel("env")).toBe("HOUNDSMAN_MAKI_PATH");
	});
});

describe("installMaki (arquivo local)", () => {
	const hasTar = Boolean(Bun.which("tar"));

	test.skipIf(!hasTar)("extrai, grava o ponteiro e remove", async () => {
		const home = tempDir("houndsman-maki-home-");
		process.env.HOUNDSMAN_HOME = home;

		const src = tempDir("houndsman-maki-src-");
		const name = makiBinaryName();
		mkdirSync(join(src, "nested"), { recursive: true });
		writeFileSync(join(src, "nested", name), "#!/bin/sh\necho fake\n");
		const archive = join(tempDir("houndsman-maki-archive-"), "maki.tar.gz");
		const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", src, "."], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(tar.exitCode).toBe(0);

		const first = await installMaki({ version: "9.9.9", from: archive });
		expect(first.skipped).toBe(false);
		expect(existsSync(first.path)).toBe(true);
		expect(first.path).toBe(join(makiInstallDir("9.9.9"), name));
		expect(readFileSync(first.path, "utf8")).toContain("echo fake");

		const manifest = readMakiInstall();
		expect(manifest?.version).toBe("9.9.9");
		expect(manifest?.path).toBe(first.path);
		expect(existsSync(makiCurrentFile())).toBe(true);

		const resolved = resolveMakiBinary();
		expect(resolved?.source).toBe("managed");
		expect(resolved?.version).toBe("9.9.9");

		const second = await installMaki({ version: "9.9.9", from: archive });
		expect(second.skipped).toBe(true);

		const removed = uninstallMaki();
		expect(removed).toBe(join(home, "tools", "maki"));
		expect(existsSync(join(home, "tools", "maki"))).toBe(false);
	});
});
