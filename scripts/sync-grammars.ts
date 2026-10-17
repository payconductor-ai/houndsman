/**
 * Sincroniza as grammars wasm vendorizadas (`assets/grammars/`).
 *
 * As grammars são comprometidas no repositório para garantir ABI compatível com
 * o `web-tree-sitter` pinado e funcionamento offline. Rode este script após
 * atualizar as versões em `package.json` e revise o diff binário.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const destination = join(root, "assets", "grammars");
const sources = [
	["web-tree-sitter", "web-tree-sitter.wasm"],
	["@vscode/tree-sitter-wasm", "wasm/tree-sitter-typescript.wasm"],
	["@vscode/tree-sitter-wasm", "wasm/tree-sitter-tsx.wasm"],
	["@vscode/tree-sitter-wasm", "wasm/tree-sitter-javascript.wasm"],
] as const;

mkdirSync(destination, { recursive: true });
for (const [pkg, file] of sources) {
	const from = join(root, "node_modules", pkg, file);
	const to = join(destination, file.split("/").at(-1) ?? file);
	copyFileSync(from, to);
	console.log(`~ ${to.replace(`${root}\\`, "").replaceAll("\\", "/")}`);
}
