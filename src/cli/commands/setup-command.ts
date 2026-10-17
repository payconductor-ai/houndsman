/** Comandos que não dependem da config do projeto: setup, update e test. */

import type { CliContext, Command } from "./command";

export class SetupCommand implements Command {
	readonly name = "setup";

	async run(args: string[], context: CliContext): Promise<number> {
		const { runSetupCommand } = await import("../../core/commands/setup");
		const messages = await runSetupCommand({ cwd: context.cwd, args });
		for (const message of messages) context.out(message);
		return 0;
	}
}

export class UpdateCommand implements Command {
	readonly name = "update";

	async run(args: string[], context: CliContext): Promise<number> {
		const { runUpdateCommand } = await import("../../core/commands/update");
		const messages = await runUpdateCommand({ cwd: context.cwd, args });
		for (const message of messages) context.out(message);
		return 0;
	}
}

export class TestCommand implements Command {
	readonly name = "test";

	async run(_args: string[], _context: CliContext): Promise<number> {
		const { runLibTests } = await import("../../core/commands/test");
		return runLibTests();
	}
}
