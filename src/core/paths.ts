/**
 * Utilidades de path para logs (biblioteca).
 */

import { relative } from "node:path";

/** Caminho relativo ao cwd, sempre com `/` (portável/legível em logs). */
export function relFromRoot(absPath: string): string {
	return relative(process.cwd(), absPath).replace(/\\/g, "/");
}
