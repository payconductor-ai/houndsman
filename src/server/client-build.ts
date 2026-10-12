/**
 * Empacota o cliente Preact em memória (Bun.build) — sem build step no pacote.
 *
 * Sem cache por padrão: o bundle é refeito quando algum arquivo do cliente muda
 * (comparação por mtime), então editar a UI não exige reiniciar o servidor. O
 * navegador também não cacheia (`cache-control: no-store` + `?v=` na URL).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;
let cachedStamp = -1;

/** Maior mtime entre os arquivos do cliente (recursivo). */
function sourceStamp(dir: string): number {
	let stamp = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		stamp = Math.max(
			stamp,
			entry.isDirectory() ? sourceStamp(full) : statSync(full).mtimeMs,
		);
	}
	return stamp;
}

/** Bundle ESM do cliente (target browser). Lança se o build falhar. */
export async function buildClientBundle(): Promise<string> {
	const sourceDir = join(import.meta.dir, "client");
	const stamp = sourceStamp(sourceDir);
	if (cached !== null && stamp === cachedStamp) return cached;

	const result = await Bun.build({
		entrypoints: [join(sourceDir, "index.tsx")],
		target: "browser",
		format: "esm",
		jsx: { runtime: "automatic", importSource: "preact" },
	});
	if (!result.success || result.outputs.length === 0) {
		const details = (result.logs ?? []).map((log) => log.message).join("\n");
		throw new Error(`Falha ao empacotar o cliente do houndsman.\n${details}`);
	}
	cached = await result.outputs[0].text();
	cachedStamp = stamp;
	return cached;
}
