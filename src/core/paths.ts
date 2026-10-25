/**
 * Caminhos do houndsman (biblioteca): raiz relativa para logs + layout fixo da
 * camada de projeto (`.houndsman/`).
 *
 * A camada gerada tem local fixo, então nada aqui é configurável pelo projeto.
 * Dados de execução (reviews/findings/artefatos) vivem no storage global; aqui
 * ficam só os paths da camada e os nomes dos artefatos de staging.
 */

import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { OUTPUT_FORMAT_FILE } from "./assets";

/** Caminho relativo ao cwd, sempre com `/` (portável/legível em logs). */
export function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Caminho legível para mensagens: `~/...` quando sob o home, senão absoluto. */
export function displayPath(absPath: string): string {
	const home = homedir();
	if (absPath === home) return "~";
	if (absPath.startsWith(`${home}${sep}`)) {
		return `~${absPath.slice(home.length).replace(/\\/g, "/")}`;
	}
	return absPath.replace(/\\/g, "/");
}

/** Diretório da camada de projeto (regras + artefatos). */
export const PROJECT_DIR = ".houndsman";

/** Subdiretório dos arquivos auto-gerados (sincronizados por `update`). */
export const CORE_DIR = `${PROJECT_DIR}/core`;

/** Skill canônico (markdown) dentro da camada gerada. */
export const CORE_SKILL_DIR = `${CORE_DIR}/skill`;

/** Schema de output dos watchdogs, citado nos briefs. */
export const OUTPUT_FORMAT_PATH = `${CORE_SKILL_DIR}/${OUTPUT_FORMAT_FILE}`;

/** Contexto bruto da PR (`gh pr view`), no staging da review. */
export const CONTEXT_FILE = "context.json";

/** Resumo do contexto gravado pelo subagente, no staging da review. */
export const CONTEXT_SUMMARY_FILE = "context-summary.json";

/** Brief do subagente que resume o contexto da PR. */
export const CONTEXT_BRIEF_FILE = "context-brief.md";

/** Modelo de intenção da PR (negócio) — insumo obrigatório do revisor `general`. */
export const BUSINESS_SUMMARY_FILE = "business-summary.json";

/** Brief do passo de intenção (subagente na skill / pré-passe no hunt). */
export const BUSINESS_BRIEF_FILE = "business-brief.md";

/** Relatório da verificação de findings (artefato `verify.md`). */
export const VERIFY_FILE = "verify.md";

/** Resumo final da review (artefato `review-resume.md`) — leitura humana apenas. */
export const REVIEW_RESUME_FILE = "review-resume.md";

/** Pontos técnicos estruturais usados no resumo final (`technical-summary.json`). */
export const TECHNICAL_SUMMARY_FILE = "technical-summary.json";
