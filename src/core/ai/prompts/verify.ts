/**
 * Prompt de confirmação de findings (`AiVerifier`).
 */

import { buildSystem } from "./base";

/** Entrada do prompt. */
export type VerifyPromptInput = {
	findings: readonly {
		id: string;
		rule: string;
		file: string;
		line: number | null;
		message: string;
		snippets: string;
	}[];
};

/** Instruções de sistema. */
export function verifyInstructions(): string {
	return buildSystem("Você confirma ou refuta achados de revisão de código.", [
		"Para cada achado, decida se a violação persiste no código atual.",
		"Baseie-se apenas no trecho fornecido.",
		"Confiança calibrada entre 0 e 1.",
		"Não invente ids.",
	]);
}

/** Prompt do usuário. */
export function verifyPrompt(input: VerifyPromptInput): string {
	const blocks = input.findings.flatMap((finding) => [
		`### ${finding.id} — ${finding.rule}`,
		`Arquivo: ${finding.file}${finding.line ? `:${finding.line}` : ""}`,
		`Achado: ${finding.message}`,
		"```",
		finding.snippets,
		"```",
	]);
	return [...blocks, "", "Produza os vereditos em JSON."].join("\n");
}
