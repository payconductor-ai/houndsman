/**
 * Helpers de apresentação: data/hora das runs e link para abrir o arquivo no
 * VS Code (`vscode://file/...`).
 */

/** Data/hora curta em pt-BR — ex.: `14 de out., 17:48`. */
export function formatRunTime(iso?: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("pt-BR", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

/** Tempo relativo curto — ex.: `há 8s`, `há 3min`. */
export function formatElapsed(seconds: number): string {
	if (seconds < 2) return "agora";
	if (seconds < 60) return `há ${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `há ${minutes}min`;
	return `há ${Math.floor(minutes / 60)}h`;
}

/**
 * Link `vscode://file/<caminho>:<linha>` para abrir o arquivo no editor.
 * Devolve null sem caminho absoluto (o handler do VS Code não resolve relativo).
 */
export function vscodeFileLink(file: string, line?: number | null): string | null {
	const path = file.replace(/\\/g, "/");
	if (!/^([a-zA-Z]:\/|\/)/.test(path)) return null;
	const normalized = path.replace(
		/^([A-Za-z]):/,
		(_, drive) => `${drive.toLowerCase()}:`,
	);
	return `vscode://file/${encodeURI(normalized)}${line ? `:${line}` : ""}`;
}
