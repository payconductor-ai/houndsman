/**
 * Prompt dos pontos técnicos estruturais (`AiTechnicalSummarizer`).
 */

import { buildSystem, clip } from "./base";

/** Instruções de sistema dos pontos técnicos. */
export function technicalInstructions(): string {
	return buildSystem(
		"Você descreve a estrutura técnica de uma Pull Request para revisores.",
		[
			"Foque em arquitetura e contratos: novos módulos/services, interfaces, providers, repositories, camadas, exports, dependências e impacto.",
			"NÃO avalie qualidade, NÃO liste achados, bugs ou riscos de revisão.",
			"NÃO repita a motivação de negócio: isso pertence ao resumo de negócio.",
			"Use no máximo 6 destaques; `area` é um rótulo curto e `detail` cita paths/símbolos concretos.",
			"Não invente módulos, símbolos ou dependências ausentes dos dados.",
		],
	);
}

/** Prompt do usuário com o payload estrutural já compactado. */
export function technicalPrompt(payload: unknown): string {
	return [
		"Descreva os pontos técnicos estruturais da mudança abaixo.",
		"",
		"```json",
		clip(JSON.stringify(payload), 14_000),
		"```",
	].join("\n");
}
