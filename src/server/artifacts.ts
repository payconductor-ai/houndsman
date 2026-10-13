/**
 * Descoberta de runs e leitura segura de artefatos (servidor).
 *
 * Toda leitura é restrita à pasta da run — `readRunFile` barra path traversal.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Arquivos que marcam uma pasta como "run" do houndsman. */
const RUN_MARKERS = [
	"manifest.json",
	"state.json",
	"run.json",
	"classification.json",
	"review.md",
] as const;

/** Slugs (nomes de pasta) das runs sob o `artifactDir`. */
export function listRunSlugs(artifactDir: string): string[] {
	if (!existsSync(artifactDir)) return [];
	try {
		return readdirSync(artifactDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((slug) =>
				RUN_MARKERS.some((marker) => existsSync(join(artifactDir, slug, marker))),
			)
			.sort();
	} catch {
		return [];
	}
}

/** Diretório absoluto de uma run; null se o slug for inválido/inexistente. */
export function runDirForSlug(artifactDir: string, slug: string): string | null {
	if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return null;
	const dir = join(artifactDir, slug);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
	return dir;
}

/** Lê um arquivo DENTRO da run; null se ausente ou fora do diretório. */
export function readRunFile(runDir: string, name: string): string | null {
	const root = resolve(runDir);
	const target = resolve(root, name);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	try {
		return existsSync(target) && statSync(target).isFile()
			? readFileSync(target, "utf8")
			: null;
	} catch {
		return null;
	}
}

/** Lê e faz parse de um JSON da run (null se ausente/inválido). */
export function readRunJson<T>(runDir: string, name: string): T | null {
	const raw = readRunFile(runDir, name);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
