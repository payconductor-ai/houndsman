/**
 * Execução do binário `git` (biblioteca) — única camada que fala com o processo.
 *
 * `core.quotepath=false` mantém paths literais (acentos/unicode). O runner é
 * injetável nos testes; `GitRepository` é a superfície OO sobre estes helpers.
 */

/** Resultado cru de uma execução do git (nunca lança). */
export type GitResult = {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
};

/** Executa `git` e devolve o resultado cru. Injetável nos testes. */
export type GitRunner = (args: string[]) => GitResult;

/**
 * Cria um runner do git com diretório de trabalho fixo.
 *
 * O servidor roda a partir da raiz do repositório, mas o checkout pode ser
 * disparado de outra sessão — o `cwd` garante que os comandos atinjam o repo
 * certo. Sem `cwd`, herda o diretório do processo (default).
 */
export function createGitRunner(cwd?: string): GitRunner {
	return (args) => {
		const result = Bun.spawnSync(["git", "-c", "core.quotepath=false", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = result.exitCode ?? 1;
		return {
			ok: code === 0,
			code,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
		};
	};
}

/** Runner padrão: `git -c core.quotepath=false <args>` a partir do cwd. */
export const defaultGitRunner: GitRunner = createGitRunner();

/** Executa e devolve o stdout; lança com o stderr quando o git falha. */
export function runGit(args: string[], runner: GitRunner = defaultGitRunner): string {
	const result = runner(args);
	if (!result.ok) {
		throw new Error(`git ${args.join(" ")} falhou: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** Executa o git sem lançar (para sondagens como `merge-base`/`show`). */
export function tryGit(args: string[], runner: GitRunner = defaultGitRunner): GitResult {
	return runner(args);
}
