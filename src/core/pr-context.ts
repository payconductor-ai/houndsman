/**
 * Coleta/leitura do contexto da PR via GitHub CLI (`gh`) — biblioteca.
 *
 * Usado pelo subcomando `context` (`cli/index.ts`). O `gh` é
 * OPCIONAL: sem binário, sem login ou sem PR para a branch, grava
 * `context.json` com `{ available: false, reason }` e sai com código 0.
 *
 * Artefatos (em --dir, default .houndsman/.runs/<branch-slug>/):
 *   context.json      payload bruto do `gh pr view` (ou marcador de indisponível)
 *   context-brief.md  instruções para o subagente resumir o contexto
 *
 * O subagente lê o brief e grava `context-summary.json`, consumido pelo
 * orchestrator (briefs dos revisores + relatório final).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	type ContextSummary,
	parseContextSummary,
	sanitizeBranch,
} from "./report-builder";

export const CONTEXT_FILE = "context.json";
export const CONTEXT_SUMMARY_FILE = "context-summary.json";
export const CONTEXT_BRIEF_FILE = "context-brief.md";

const GH_JSON_FIELDS =
	"number,title,body,url,baseRefName,headRefName,author,commits,files";

export type ContextUnavailableReason =
	| "gh-missing"
	| "gh-unauthenticated"
	| "no-pr"
	| "error";

/** Payload bruto gravado em `context.json` (inclusive quando indisponível). */
export type PrContextRaw = {
	available: boolean;
	reason?: ContextUnavailableReason;
	detail?: string;
	collectedAt: string;
	source?: {
		number?: number;
		title?: string;
		url?: string;
		base?: string;
		head?: string;
		author?: string;
	};
	body?: string;
	commits?: string[];
	files?: { path: string; additions?: number; deletions?: number }[];
	stats?: { files: number; additions: number; deletions: number };
};

export type ContextPaths = {
	dir: string;
	context: string;
	summary: string;
	brief: string;
};

/** Caminhos dos artefatos de contexto para uma branch. */
export function contextPaths(dir: string, branch: string): ContextPaths {
	const dirPath = join(dir, sanitizeBranch(branch));
	return {
		dir: dirPath,
		context: join(dirPath, CONTEXT_FILE),
		summary: join(dirPath, CONTEXT_SUMMARY_FILE),
		brief: join(dirPath, CONTEXT_BRIEF_FILE),
	};
}

/** Caminho relativo à raiz, sempre com `/` (portável/legível). */
function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Detecta a branch atual; encerra com erro se não houver. */
export function currentBranch(): string {
	const result = Bun.spawnSync(["git", "branch", "--show-current"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const branch = new TextDecoder().decode(result.stdout).trim();
	if (!branch) {
		console.error("Não foi possível detectar a branch. Use --branch <nome>.");
		process.exit(1);
	}
	return branch;
}

function runGh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: result.exitCode === 0,
		stdout: new TextDecoder().decode(result.stdout).trim(),
		stderr: new TextDecoder().decode(result.stderr).trim(),
	};
}

type GhPrView = {
	number?: number;
	title?: string;
	body?: string;
	url?: string;
	baseRefName?: string;
	headRefName?: string;
	author?: { login?: string; name?: string };
	commits?: { messageHeadline?: string; message?: string }[];
	files?: { path?: string; additions?: number; deletions?: number }[];
};

function unavailable(reason: ContextUnavailableReason, detail: string): PrContextRaw {
	return {
		available: false,
		reason,
		detail,
		collectedAt: new Date().toISOString(),
	};
}

/** Lê a PR da branch via `gh` e devolve o payload bruto (nunca lança). */
export function collectPrContext(branch: string): PrContextRaw {
	const collectedAt = new Date().toISOString();

	if (!Bun.which("gh")) {
		return unavailable("gh-missing", "GitHub CLI (gh) não encontrado no PATH.");
	}

	const auth = runGh(["auth", "status"]);
	if (!auth.ok) {
		return unavailable(
			"gh-unauthenticated",
			auth.stderr || "gh não autenticado (rode `gh auth login`).",
		);
	}

	const view = runGh(["pr", "view", branch, "--json", GH_JSON_FIELDS]);
	if (!view.ok) {
		const noPr = /no pull requests? found|not found|could not find/i.test(
			view.stderr,
		);
		return unavailable(noPr ? "no-pr" : "error", view.stderr || "gh pr view falhou.");
	}

	let parsed: GhPrView;
	try {
		parsed = JSON.parse(view.stdout) as GhPrView;
	} catch {
		return unavailable("error", "Resposta inválida do gh (JSON malformado).");
	}

	const files = (parsed.files ?? [])
		.filter((f): f is { path: string; additions?: number; deletions?: number } =>
			Boolean(f?.path),
		)
		.map((f) => ({
			path: f.path,
			additions: f.additions,
			deletions: f.deletions,
		}));
	const commits = (parsed.commits ?? [])
		.map((c) => c.messageHeadline ?? c.message ?? "")
		.filter((m) => m.length > 0);

	return {
		available: true,
		collectedAt,
		source: {
			number: parsed.number,
			title: parsed.title,
			url: parsed.url,
			base: parsed.baseRefName,
			head: parsed.headRefName,
			author: parsed.author?.name ?? parsed.author?.login,
		},
		body: parsed.body?.trim() || undefined,
		commits: commits.length > 0 ? commits : undefined,
		files: files.length > 0 ? files : undefined,
		stats: {
			files: files.length,
			additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
			deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
		},
	};
}

/** Lê o `context-summary.json` (schema do subagente); null se ausente/inválido. */
export function readContextSummary(filePath: string): ContextSummary | null {
	if (!existsSync(filePath)) return null;
	try {
		return parseContextSummary(JSON.parse(readFileSync(filePath, "utf8")));
	} catch {
		return null;
	}
}

/** Instruções prontas para o subagente que resume o contexto da PR. */
export function renderContextBrief(
	context: PrContextRaw,
	branch: string,
	paths: ContextPaths,
): string {
	const lines: string[] = [];

	lines.push("# Brief — Contexto da PR (subagente)", "");
	lines.push(`**Branch:** ${branch}`);
	lines.push(`**Contexto bruto:** \`${relFromRoot(paths.context)}\``);
	lines.push(`**Output obrigatório:** \`${relFromRoot(paths.summary)}\``, "");

	lines.push("## Objetivo", "");
	lines.push(
		"Resumir a PR para abrir o relatório de revisão em **Objetivo**,",
		"**Motivação** e **Resumo das alterações** (pt-BR).",
		"",
	);

	lines.push("## Instruções", "");
	if (!context.available) {
		lines.push(
			`O contexto está **indisponível** (\`${context.reason}\`). Grave o output com`,
			'`{ "available": false }` e encerre. Não invente conteúdo.',
			"",
		);
	} else {
		lines.push("1. Leia o `context.json` (title, body, commits, files).");
		lines.push("2. Sintetize em pt-BR: objetivo, motivação e resumo das alterações.");
		lines.push("3. Grave o output no schema abaixo. Não escreva markdown livre.");
		lines.push("");
	}

	lines.push("## Schema do output (`context-summary.json`)", "");
	lines.push("```json");
	lines.push(JSON.stringify(CONTEXT_SUMMARY_TEMPLATE, null, 2));
	lines.push("```", "");

	lines.push("## Regras", "");
	lines.push(
		"- **Seja curto** — o resumo abre o relatório e entra em **todos** os briefs.",
	);
	lines.push("- Baseie-se **somente** no `context.json` — não invente intenção.");
	lines.push("- `objective`: 1 frase (≤ 200 caracteres) sobre o que a PR entrega.");
	lines.push("- `motivation`: 1 frase (≤ 240 caracteres) sobre o porquê.");
	lines.push(
		"- `changeSummary`: no máximo 4 bullets (≤ 160 caracteres cada), focados em comportamento — não liste arquivos.",
	);
	lines.push(
		"- NÃO copie a descrição da PR: sintetize. Copie `source` do contexto bruto.",
	);

	return lines.join("\n");
}

const CONTEXT_SUMMARY_TEMPLATE = {
	available: true,
	source: {
		number: 1,
		title: "Título da PR",
		url: "https://github.com/org/repo/pull/1",
		base: "main",
		head: "feature/x",
	},
	objective: "O que a PR entrega, em 1 frase.",
	motivation: "Por que a mudança é necessária, em 1-2 frases.",
	changeSummary: ["Bullet de comportamento 1", "Bullet de comportamento 2"],
};
