/**
 * Opções de uma run (flags do CLI já resolvidas).
 *
 * Fica fora do `orchestrator` para as pipelines importarem o tipo sem ciclo.
 */

export type ReviewOptions = {
	base: string;
	head: string;
	branch?: string;
	/**
	 * Rótulo da variante A/B. Cada variante vira uma run própria
	 * (`repoKey`, `branch`, `variant`) — permite comparar sem apagar a anterior.
	 */
	variant?: string;
	finalize: boolean;
	failOnBlocking: boolean;
	clean: boolean;
	noJev: boolean;
	/** Desativa a análise estrutural (AST) nesta run. */
	noAst: boolean;
	/** Força review completo (ignora o modo incremental). */
	full: boolean;
	/** Desativa as features de IA do fluxo normal. */
	noAi: boolean;
	/** PR de origem (resolvida via `--pr`). */
	pr?: number;
	/** Worktree informado via flag (`--worktree`). */
	worktree?: string;
	/** Worktree resolvido (absoluto; ausente = clone principal). */
	worktreePath?: string;
};

/** Valores default das opções (o CLI sobrepõe com as flags). */
export function defaultOptions(): ReviewOptions {
	return {
		base: "main",
		head: "HEAD",
		finalize: false,
		failOnBlocking: false,
		clean: false,
		noJev: false,
		noAst: false,
		full: false,
		noAi: false,
	};
}
