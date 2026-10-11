/**
 * "Project fake" usado pela suíte de testes da lib.
 *
 * Os testes validam o MOTOR (`core/`), não as regras de um projeto real —
 * por isso usam esta configuração fictícia em vez da config do projeto real.
 */

import { defineReviewConfig, type ReviewConfig } from "../../core/config";
import { defineReviewer } from "../../core/types";

/** Revisor A — regra com spec Jev (`true`) e um anti-padrão. */
export const alphaReviewer = defineReviewer({
	id: "alpha",
	name: "Alpha",
	description: "Revisor A do projeto fake.",
	scope: "src/alpha/**",
	classify: [{ value: "^src/alpha/" }],
	criticalRules: [
		["blocking", "Nunca usar `any`.", true],
		["attention", "Validar entrada do usuário."],
	],
	antiPatterns: [["suggestion", "Evitar console.log."]],
	contextFiles: ["README.md"],
});

/** Revisor B — cobre testes e um padrão de nome de arquivo. */
export const betaReviewer = defineReviewer({
	id: "beta",
	name: "Beta",
	description: "Revisor B do projeto fake.",
	scope: "src/beta/**, arquivos de teste e o arquivo especial",
	classify: [
		{ value: "^src/beta/" },
		{ value: "\\.test\\.ts$" },
		{ value: "special\\.ts$" },
	],
	criticalRules: [
		["blocking", "Nunca commitar segredos.", "O estado contém segredo hardcoded?"],
	],
	antiPatterns: [["attention", "Evitar código morto."]],
	contextFiles: ["README.md"],
});

export const FAKE_REVIEWER_DEFINITIONS = {
	alpha: alphaReviewer,
	beta: betaReviewer,
};

export type FakeReviewerId = keyof typeof FAKE_REVIEWER_DEFINITIONS;

/** Configuração completa do projeto fake. */
export const fakeReviewConfig: ReviewConfig<FakeReviewerId> =
	defineReviewConfig<FakeReviewerId>({
		projectName: "Fake Project",
		artifactDir: "tmp/fake-review",
		reviewers: FAKE_REVIEWER_DEFINITIONS,
		exclusions: [/^dist\//, /\.lock$/],
		docMappings: [[/^src\//, ["README.md"]]],
		alwaysIncludeDocs: ["README.md"],
	});
