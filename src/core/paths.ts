/**
 * Utilidades de path do motor (biblioteca) — logs e diretório dos artefatos.
 */

import { relative } from "node:path";
import { sanitizeBranch } from "./report-builder";

/** Caminho relativo ao cwd, sempre com `/` (portável/legível em logs). */
export function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}

/** Data local no formato `YYYY-MM-DD`. */
export function dateStamp(date: Date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Nome do diretório de uma revisão dentro de `artifactDir`: `<branch-slug>-<YYYY-MM-DD>`.
 * Ex.: branch `feature/add-webhook` em 2026-10-11 → `feature-add-webhook-2026-10-11`.
 */
export function reviewDirName(branch: string, date: Date = new Date()): string {
	return `${sanitizeBranch(branch)}-${dateStamp(date)}`;
}
