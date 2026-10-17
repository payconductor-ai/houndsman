/**
 * "Project fake" usado pela suíte de testes da lib.
 *
 * Os testes validam o MOTOR (`core/`), não as regras de um projeto real —
 * por isso usam esta configuração fictícia em vez da config do projeto real.
 */

import { defineHoundsmanConfig, type HoundsmanConfig } from "../../core/config";
import { defineWatchdog } from "../../core/types";

/** Watchdog A — regra bloqueante com spec Jev + outras severidades. */
export const alphaWatchdog = defineWatchdog({
	id: "alpha",
	name: "Alpha",
	description: "Watchdog A do projeto fake.",
	scope: "src/alpha/**",
	classify: [{ value: "^src/alpha/" }],
	rules: [
		{ severity: "blocking", text: "Nunca usar `any`.", jev: { kind: "noul" } },
		{ severity: "attention", text: "Validar entrada do usuário." },
		{ severity: "suggestion", text: "Evitar console.log." },
	],
	contextFiles: ["README.md"],
});

/** Watchdog B — cobre testes e um padrão de nome de arquivo. */
export const betaWatchdog = defineWatchdog({
	id: "beta",
	name: "Beta",
	description: "Watchdog B do projeto fake.",
	scope: "src/beta/**, arquivos de teste e o arquivo especial",
	classify: [
		{ value: "^src/beta/" },
		{ value: "\\.test\\.ts$" },
		{ value: "special\\.ts$" },
	],
	rules: [
		{
			severity: "blocking",
			text: "Nunca commitar segredos.",
			jev: { kind: "noul", instructions: "O estado contém segredo hardcoded?" },
		},
		{ severity: "attention", text: "Evitar código morto." },
	],
	contextFiles: ["README.md"],
});

export const FAKE_WATCHDOG_DEFINITIONS = {
	alpha: alphaWatchdog,
	beta: betaWatchdog,
};

export type FakeWatchdogId = keyof typeof FAKE_WATCHDOG_DEFINITIONS;

/** Configuração completa do projeto fake. */
export const fakeHoundsmanConfig: HoundsmanConfig<FakeWatchdogId> =
	defineHoundsmanConfig<FakeWatchdogId>({
		projectName: "Fake Project",
		watchdogs: FAKE_WATCHDOG_DEFINITIONS,
		exclusions: [/^dist\//, /\.lock$/],
		docMappings: [[/^src\//, ["README.md"]]],
		alwaysIncludeDocs: ["README.md"],
	});
