/** Comando `doctor` (alias `check`) — valida config, ambiente e credencial Jev. */

import { checkRegistry } from "../../core/registry-check";
import type { CliContext, Command } from "./command";

export class DoctorCommand implements Command {
	readonly name = "doctor";

	async run(_args: string[], context: CliContext): Promise<number> {
		const engine = await context.engine();
		context.out("→ Validando configuração do projeto...");
		const { problems, warnings, jevQuestions } = checkRegistry(engine.config);

		if (problems.length > 0) {
			context.err("\n❌ Problemas na configuração de revisão:\n");
			for (const problem of problems) context.err(`  - ${problem}`);
			return 1;
		}
		context.out(
			`  ✅ ${engine.config.watchdogIds.length} watchdogs, ${jevQuestions} pergunta(s) Jev.`,
		);

		if (warnings.length > 0) {
			context.out(`\n⚠️  ${warnings.length} aviso(s) (não bloqueantes):`);
			for (const warning of warnings) context.out(`  - ${warning}`);
		}

		context.out("\n→ Ambiente:");
		context.out(`  ${Bun.which("git") ? "✅" : "❌"} git`);
		context.out(`  ${Bun.which("gh") ? "✅" : "⚠️ "} gh (opcional — contexto da PR)`);
		await this.reportJevCredential(context);
		return 0;
	}

	/**
	 * Reporta o estado da credencial Jev: presença e validade (chamada mínima).
	 * Fail-open — nunca altera o exit code (`doctor` é diagnóstico).
	 */
	private async reportJevCredential(context: CliContext): Promise<void> {
		const { JevClient } = await import("../../core/jev");
		const client = new JevClient();
		if (!client.isConfigured()) {
			context.out("  ⚠️  TYPESAFE_API_KEY (opcional — pré-análise Jev)");
			return;
		}
		const check = await client.validateCredential();
		if (check.ok) {
			context.out(`  ✅ Jev: credencial válida (modelo ${check.model}).`);
		} else if (check.kind === "invalid") {
			context.out(`  ❌ Jev: credencial inválida — ${check.detail}`);
		} else {
			context.out(`  ⚠️  Jev: não foi possível validar — ${check.detail}`);
		}
	}
}
