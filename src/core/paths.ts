/**
 * Caminhos do houndsman (biblioteca): raiz relativa para logs + layout fixo da
 * camada de projeto (`.houndsman/`).
 *
 * A camada gerada tem local fixo, então nada aqui é configurável pelo projeto:
 * o CLI deriva os artefatos e o schema de output destas constantes.
 */

import { relative } from "node:path";
import { OUTPUT_FORMAT_FILE } from "./assets";

/** Caminho relativo ao cwd, sempre com `/` (portável/legível em logs). */
export function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Diretório da camada de projeto (regras + artefatos). */
export const PROJECT_DIR = ".houndsman";

/** Subdiretório dos arquivos auto-gerados (sincronizados por `update`). */
export const CORE_DIR = `${PROJECT_DIR}/core`;

/** Skill canônico (markdown) dentro da camada gerada. */
export const CORE_SKILL_DIR = `${CORE_DIR}/skill`;

/** Artefatos da revisão (briefs, findings, review.md) — default de `artifactDir`. */
export const ARTIFACT_DIR = `${PROJECT_DIR}/.runs`;

/** Schema de output dos watchdogs, citado nos briefs. */
export const OUTPUT_FORMAT_PATH = `${CORE_SKILL_DIR}/${OUTPUT_FORMAT_FILE}`;
