/**
 * Opções do `houndsman hunt` (harness nativo).
 */

import { ArgParser } from "../../core/arg-parser";
import type { AiProviderKind } from "../../core/config";

/** Opções resolvidas do hunt. */
export type HuntOptions = {
	base: string;
	head: string;
	branch?: string;
	watchdog?: string;
	full: boolean;
	clean: boolean;
	noAst: boolean;
	/** Hunt usa IA própria; Jev fica desligado por padrão (evita custo duplo). */
	noJev: boolean;
	resume: boolean;
	allowPartial: boolean;
	dryRun: boolean;
	failOnBlocking: boolean;
	maxCalls?: number;
	concurrency?: number;
	provider?: AiProviderKind;
	model?: string;
	/** Número da PR (`--pr`) — o comando resolve/cria o worktree. */
	pr?: number;
	/** Worktree informado via flag (relativo ao cwd ou absoluto). */
	worktree?: string;
	/** Worktree resolvido (absoluto) para persistir na review. */
	worktreePath?: string;
};

/** Defaults do hunt. */
export function defaultHuntOptions(): HuntOptions {
	return {
		base: "main",
		head: "HEAD",
		full: false,
		clean: false,
		noAst: false,
		noJev: true,
		resume: false,
		allowPartial: false,
		dryRun: false,
		failOnBlocking: false,
	};
}

/** Converte argv nas opções do hunt. */
export function parseHuntArgs(args: string[]): HuntOptions {
	const parser = ArgParser.from(args);
	const options = defaultHuntOptions();
	const base = parser.value("--base");
	const head = parser.value("--head");
	const branch = parser.value("--branch");
	const watchdog = parser.value("--watchdog");
	const provider = parser.value("--provider");
	const model = parser.value("--model");
	const maxCalls = parser.value("--max-calls");
	const concurrency = parser.value("--concurrency");
	const pr = parser.value("--pr");
	const worktree = parser.value("--worktree");
	if (pr) {
		const number = Number.parseInt(pr, 10);
		if (Number.isFinite(number) && number > 0) options.pr = number;
		else throw new Error(`--pr inválido: '${pr}'.`);
	}
	if (worktree) options.worktree = worktree;
	if (options.pr !== undefined && options.worktree !== undefined) {
		throw new Error("Use --pr ou --worktree, não os dois.");
	}
	if (base) options.base = base;
	if (head) options.head = head;
	if (branch) options.branch = branch;
	if (watchdog) options.watchdog = watchdog;
	if (provider) options.provider = provider as AiProviderKind;
	if (model) options.model = model;
	if (maxCalls) options.maxCalls = Number.parseInt(maxCalls, 10);
	if (concurrency) options.concurrency = Number.parseInt(concurrency, 10);

	if (parser.has("--full")) options.full = true;
	if (parser.has("--clean")) options.clean = true;
	if (parser.has("--no-ast")) options.noAst = true;
	if (parser.has("--with-jev")) options.noJev = false;
	if (parser.has("--resume")) options.resume = true;
	if (parser.has("--allow-partial")) options.allowPartial = true;
	if (parser.has("--dry-run")) options.dryRun = true;
	if (parser.has("--fail-on-blocking")) options.failOnBlocking = true;
	return options;
}
