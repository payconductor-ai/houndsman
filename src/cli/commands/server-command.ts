/** Comando `server` — sobe a UI local de triagem. */

import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

/** Abre a URL no navegador padrão (best-effort, por plataforma). */
function openBrowser(url: string): void {
	try {
		const command =
			process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: process.platform === "darwin"
					? ["open", url]
					: ["xdg-open", url];
		Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
	} catch {
		// best-effort — se não abrir, o usuário copia a URL.
	}
}

export class ServerCommand implements Command {
	readonly name = "server";

	async run(args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		const parser = ArgParser.from(args);
		const port = Number(parser.value("--port")) || 7331;
		const host = parser.value("--host") ?? "127.0.0.1";
		const editorPreference = parser.value("--editor");

		const { startServer } = await import("../../server");
		const { url } = startServer({
			config: engine.config,
			port,
			host,
			editorPreference,
		});
		context.out(`[houndsman] servidor em ${url}`);
		context.out("[houndsman] Ctrl+C para encerrar.");
		if (parser.has("--open")) openBrowser(url);
		return 0;
	}
}
