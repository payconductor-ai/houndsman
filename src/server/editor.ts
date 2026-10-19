/**
 * Detecção do editor que hospeda o terminal do servidor (biblioteca do servidor).
 *
 * VS Code e JetBrains expõem variáveis próprias no terminal integrado. O
 * contexto alimenta os links de código da UI (`vscode://` / `jetbrains://`).
 * A detecção é pura e fail-open: sem pistas, o editor fica `none`.
 */

import { basename, resolve } from "node:path";

/** Editores com esquema de URL próprio. */
export type EditorKind = "vscode" | "jetbrains" | "none";

/** Contexto usado pelo cliente para montar os links de código. */
export type EditorContext = {
	kind: EditorKind;
	/** Nome do projeto aberto no IDE (basename da raiz do repositório). */
	project?: string;
	/** Código do produto JetBrains (`idea`, `webstorm`, `pycharm`…). */
	product?: string;
};

type Env = Record<string, string | undefined>;

/** Bundle macOS → código do produto usado no esquema `jetbrains://`. */
const BUNDLE_PRODUCTS: Record<string, string> = {
	"com.jetbrains.intellij": "idea",
	"com.jetbrains.intellij.ce": "idea",
	"com.jetbrains.pycharm": "pycharm",
	"com.jetbrains.pycharm.ce": "pycharm",
	"com.jetbrains.webstorm": "webstorm",
	"com.jetbrains.goland": "goland",
	"com.jetbrains.clion": "clion",
	"com.jetbrains.rider": "rider",
	"com.jetbrains.phpstorm": "phpstorm",
	"com.jetbrains.rubymine": "rubymine",
	"com.jetbrains.datagrip": "datagrip",
	"com.jetbrains.appcode": "appcode",
	"com.jetbrains.rustrover": "rustrover",
};

/** Variáveis `*_INITIAL_DIRECTORY` → produto JetBrains. */
const DIR_PRODUCTS: [string, string][] = [
	["IDEA_INITIAL_DIRECTORY", "idea"],
	["PYCHARM_INITIAL_DIRECTORY", "pycharm"],
	["WEBSTORM_INITIAL_DIRECTORY", "webstorm"],
	["GOLAND_INITIAL_DIRECTORY", "goland"],
	["CLION_INITIAL_DIRECTORY", "clion"],
	["RIDER_INITIAL_DIRECTORY", "rider"],
	["PHPSTORM_INITIAL_DIRECTORY", "phpstorm"],
	["RUBYMINE_INITIAL_DIRECTORY", "rubymine"],
	["DATAGRIP_INITIAL_DIRECTORY", "datagrip"],
	["RUSTROVER_INITIAL_DIRECTORY", "rustrover"],
];

function projectName(repoRoot: string): string {
	return basename(resolve(repoRoot));
}

/** Produto JetBrains detectado no ambiente (undefined quando ambíguo). */
export function detectJetBrainsProduct(env: Env): string | undefined {
	const bundle = env.__CFBundleIdentifier?.toLowerCase();
	if (bundle) {
		const exact = BUNDLE_PRODUCTS[bundle];
		if (exact) return exact;
		const prefix = Object.keys(BUNDLE_PRODUCTS).find((key) => bundle.startsWith(key));
		if (prefix) return BUNDLE_PRODUCTS[prefix];
	}
	for (const [name, product] of DIR_PRODUCTS) {
		if (env[name]) return product;
	}
	return undefined;
}

function isJetBrains(env: Env): boolean {
	const bundle = env.__CFBundleIdentifier?.toLowerCase() ?? "";
	return (
		/jetbrains/i.test(env.TERMINAL_EMULATOR ?? "") ||
		bundle.startsWith("com.jetbrains.") ||
		DIR_PRODUCTS.some(([name]) => Boolean(env[name]))
	);
}

function isVsCode(env: Env): boolean {
	return (
		env.TERM_PROGRAM === "vscode" ||
		env.TERM_PROGRAM === "vscode-insiders" ||
		Boolean(env.VSCODE_PID || env.VSCODE_IPC_HOOK_CLI || env.VSCODE_GIT_IPC_HANDLE)
	);
}

/** Detecta o editor a partir do ambiente do terminal integrado. */
export function detectEditor(env: Env, repoRoot: string): EditorContext {
	const project = projectName(repoRoot);
	if (isJetBrains(env)) {
		return {
			kind: "jetbrains",
			project,
			product: detectJetBrainsProduct(env) ?? "idea",
		};
	}
	if (isVsCode(env)) return { kind: "vscode", project };
	return { kind: "none", project };
}

/**
 * Resolve a preferência do `--editor`.
 *
 * `auto` (ou ausente) detecta do ambiente; `vscode`/`jetbrains`/`none` forçam
 * o comportamento. Valores desconhecidos caem na detecção automática.
 */
export function resolveEditor(
	preference: string | undefined,
	env: Env,
	repoRoot: string,
): EditorContext {
	const value = preference?.trim().toLowerCase();
	const project = projectName(repoRoot);
	if (value === "vscode") return { kind: "vscode", project };
	if (value === "jetbrains") {
		return {
			kind: "jetbrains",
			project,
			product: detectJetBrainsProduct(env) ?? "idea",
		};
	}
	if (value === "none") return { kind: "none", project };
	return detectEditor(env, repoRoot);
}
