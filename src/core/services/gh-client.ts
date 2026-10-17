/**
 * Cliente do GitHub CLI (`gh`) — biblioteca.
 *
 * Um único runner para todo o motor (`context` e `findings submit`). O `gh` é
 * opcional e falha-aberto: o runner nunca lança, devolve o resultado cru.
 */

export type GhResult = { ok: boolean; code: number; stdout: string; stderr: string };

/** Executa o `gh` e devolve o resultado cru (sem lançar). */
export type GhRunner = (args: string[]) => GhResult;

/** Runner padrão: `gh` a partir do cwd; ausência do binário → `ok:false`. */
export const defaultGhRunner: GhRunner = (args) => {
	try {
		const result = Bun.spawnSync(["gh", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = result.exitCode ?? 1;
		return {
			ok: code === 0,
			code,
			stdout: new TextDecoder().decode(result.stdout).trim(),
			stderr: new TextDecoder().decode(result.stderr).trim(),
		};
	} catch (error) {
		return {
			ok: false,
			code: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
};

/** Superfície OO sobre o runner injetável. */
export class GhClient {
	private readonly runner: GhRunner;

	constructor(runner: GhRunner = defaultGhRunner) {
		this.runner = runner;
	}

	/** Executa `gh` e devolve o resultado cru. */
	run(args: string[]): GhResult {
		return this.runner(args);
	}

	/** `true` se o binário existe no PATH (independe de login). */
	isAvailable(): boolean {
		return Boolean(Bun.which("gh"));
	}
}
