/** Comando `status` — mostra o status da run ou renova o heartbeat (`status ping`). */

import { pingStatus, readStatus } from "../../core/commands/status";
import { ArgParser } from "../arg-parser";
import type { CliContext, Command } from "./command";

export class StatusCommand implements Command {
	readonly name = "status";

	async run(args: string[], context: CliContext): Promise<number> {
		const parser = ArgParser.from(args);
		const action = parser.command();
		const branch = parser.value("--branch");

		if (action && action !== "ping" && action !== "show") {
			context.err(
				`Ação desconhecida em 'status': '${action}'. Use 'status' ou 'status ping'.`,
			);
			return 1;
		}

		const engine = await context.engine();
		const result =
			action === "ping"
				? pingStatus(engine.storage, engine.repo, branch)
				: readStatus(engine.storage, engine.repo, branch);

		if (action === "ping") {
			context.out(
				result.heartbeatAt
					? `Heartbeat atualizado — ${result.branch} · ${result.status ?? "sem status"} · ${result.heartbeatAt}`
					: `Sem execução ativa — ${result.branch} · ${result.status ?? "sem status"}.`,
			);
		} else {
			context.out(
				[
					`Branch: ${result.branch}`,
					`Status: ${result.status ?? "—"}`,
					`Heartbeat: ${result.heartbeatAt ?? "—"}`,
					`Atualizado: ${result.updatedAt}`,
				].join("\n"),
			);
		}
		return 0;
	}
}
