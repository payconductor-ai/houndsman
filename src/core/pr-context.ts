/**
 * Coleta/leitura do contexto da PR via GitHub CLI (`gh`) — biblioteca.
 *
 * Usado pelo subcomando `context` (`cli/index.ts`). O `gh` é
 * OPCIONAL: sem binário, sem login ou sem PR para a branch, grava
 * `context.json` com `{ available: false, reason }` e sai com código 0.
 *
 * Artefatos no staging da review (`<HOUNDSMAN_HOME>/work/<reviewId>/`):
 *   context.json      payload bruto do `gh pr view` (ou marcador de indisponível)
 *   context-brief.md  instruções para o subagente resumir o contexto
 *
 * O subagente lê o brief e grava `context-summary.json`, consumido pelo
 * orchestrator (briefs dos watchdogs + relatório final).
 */

import { existsSync, readFileSync } from "node:fs";
import {
	CONTEXT_BRIEF_FILE,
	CONTEXT_FILE,
	CONTEXT_SUMMARY_FILE,
	relFromRoot,
} from "./paths";
import type { ContextSummary } from "./report-builder";
import { parseContextSummary } from "./report-builder";
import { systemClock } from "./services/clock";
import { defaultGhRunner, GhClient, type GhRunner } from "./services/gh-client";
import { GitRepository } from "./services/git-repository";

export { CONTEXT_BRIEF_FILE, CONTEXT_FILE, CONTEXT_SUMMARY_FILE };

/** Caminhos dos artefatos de contexto da PR (staging da review). */
export type ContextPaths = {
	dir: string;
	context: string;
	summary: string;
	brief: string;
};

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

/** Caminhos dos artefatos de contexto para uma branch. */
export function contextFileNames(): {
	context: string;
	summary: string;
	brief: string;
} {
	return {
		context: CONTEXT_FILE,
		summary: CONTEXT_SUMMARY_FILE,
		brief: CONTEXT_BRIEF_FILE,
	};
}

/** Detecta a branch atual; lança se não houver (o CLI decide o exit). */
export function currentBranch(): string {
	const branch = new GitRepository().currentBranch();
	if (!branch) {
		throw new Error("Não foi possível detectar a branch. Use --branch <nome>.");
	}
	return branch;
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
		collectedAt: systemClock(),
	};
}

/** Lê a PR da branch via `gh` e devolve o payload bruto (nunca lança). */
export function collectPrContext(
	branch: string,
	runner: GhRunner = defaultGhRunner,
): PrContextRaw {
	const collectedAt = systemClock();
	const gh = new GhClient(runner);

	if (!gh.isAvailable()) {
		return unavailable("gh-missing", "GitHub CLI (gh) não encontrado no PATH.");
	}

	const auth = gh.run(["auth", "status"]);
	if (!auth.ok) {
		return unavailable(
			"gh-unauthenticated",
			auth.stderr || "gh não autenticado (rode `gh auth login`).",
		);
	}

	const view = gh.run(["pr", "view", branch, "--json", GH_JSON_FIELDS]);
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
		"- O resumo abre o relatório e o resumo final; nos briefs ele é recortado.",
	);
	lines.push("- Baseie-se **somente** no `context.json` — não invente intenção.");
	lines.push(
		"- `objective`: até 2 frases (≤ 400 caracteres) sobre o que a PR entrega.",
	);
	lines.push(
		"- `motivation`: até 3 frases (≤ 480 caracteres) sobre o porquê e o impacto.",
	);
	lines.push(
		"- `changeSummary`: no máximo 6 bullets (≤ 240 caracteres cada), focados em comportamento — não liste arquivos.",
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
	objective: "O que a PR entrega, em 1-2 frases.",
	motivation:
		"Por que a mudança é necessária, com o problema e o impacto (até 3 frases).",
	changeSummary: ["Bullet de comportamento 1", "Bullet de comportamento 2"],
};
