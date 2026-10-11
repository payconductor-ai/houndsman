/**
 * Subcomando `test` — roda a suíte de testes da lib (project-agnóstica).
 *
 * A suíte vive em `src/tests/` e usa um "project fake"; o adotante
 * da lib não precisa escrever testes.
 */

import { join } from "node:path";

/** Diretório da suíte de testes da lib (independente do projeto). */
export const LIB_TESTS_DIR = join(import.meta.dir, "..", "..", "tests");

/** Roda a suíte de testes da lib. Devolve o exit code. */
export function runLibTests(): number {
	const result = Bun.spawnSync(["bun", "test", LIB_TESTS_DIR], {
		stdout: "inherit",
		stderr: "inherit",
	});
	return result.exitCode ?? 1;
}
