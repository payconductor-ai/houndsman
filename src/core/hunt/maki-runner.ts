/**
 * Execução headless do maki (harness local).
 *
 * Um processo por watchdog, sem TUI: o prompt vai por stdin (`maki -p`) e o
 * houndsman lê o JSON de `--output-format json`. O watchdog não recebe
 * permissão de escrita: `write`/`edit`/`bash`/rede/`task` são negados (deny
 * vence qualquer yolo). Nenhuma config global do maki é alterada.
 */

/** Ferramentas negadas ao watchdog (deny vence `--yolo`). */
export const MAKI_DISALLOWED_TOOLS =
	"bash,webfetch,websearch,write,edit,multiedit,edit_lines,insert_lines,task";

/** Pedido de execução de um watchdog. */
export type MakiRunRequest = {
	/** Prompt completo (brief + contrato). */
	prompt: string;
	/** Raiz de leitura (worktree ou clone principal). */
	cwd: string;
	/** Spec `provider/model-id`. */
	model: string;
	/** Variável nativa que o maki lê (`DEEPSEEK_API_KEY` etc.). */
	apiKeyEnv: string;
	/** Valor da chave (injetado só no processo filho). */
	apiKey: string;
	/** Timeout do processo (ms). */
	timeoutMs: number;
};

/** Uso de tokens normalizado. */
export type MakiUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
};

/** Métricas de uma execução. */
export type MakiRunMetrics = {
	sessionId?: string;
	durationMs: number;
	numTurns?: number;
	costUsd?: number;
	usage?: MakiUsage;
};

/** Resultado de uma execução. */
export type MakiRunResult =
	| {
			ok: true;
			/** Texto final do agente (deve conter o JSON dos findings). */
			text: string;
			metrics: MakiRunMetrics;
			stderr: string;
			exitCode: number;
	  }
	| {
			ok: false;
			error: string;
			metrics: MakiRunMetrics;
			stderr: string;
			exitCode?: number;
			timedOut?: boolean;
	  };

/** Runner injetável (testes usam um fake sem processo). */
export interface MakiProcessRunner {
	run(request: MakiRunRequest): Promise<MakiRunResult>;
}

/** Saída JSON do `maki --print --output-format json`. */
export type MakiJsonOutput = {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: string;
	session_id?: string;
	duration_ms?: number;
	num_turns?: number;
	total_cost_usd?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		cache_read_input_tokens?: number;
	};
};

/** Argumentos do processo (o prompt vai por stdin). */
export function makiArgs(model: string): string[] {
	return [
		"-p",
		"--output-format",
		"json",
		"--model",
		model,
		"--disallowed-tools",
		MAKI_DISALLOWED_TOOLS,
	];
}

/** Runner real, via `Bun.spawn`. */
export class SpawnMakiRunner implements MakiProcessRunner {
	private readonly binary: string;

	constructor(binary: string) {
		this.binary = binary;
	}

	async run(request: MakiRunRequest): Promise<MakiRunResult> {
		const started = Date.now();
		let timedOut = false;
		try {
			const proc = Bun.spawn([this.binary, ...makiArgs(request.model)], {
				cwd: request.cwd,
				env: { ...process.env, [request.apiKeyEnv]: request.apiKey },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			try {
				proc.stdin.write(request.prompt);
				void Promise.resolve(proc.stdin.end()).catch(() => {});
			} catch {
				// O processo pode ter encerrado antes de ler o stdin; o exit code
				// e o stderr abaixo explicam o motivo.
			}

			// Consome os pipes desde já para não travar em saídas grandes.
			const stdoutPromise = new Response(proc.stdout).text();
			const stderrPromise = new Response(proc.stderr).text();
			const timer = setTimeout(
				() => {
					timedOut = true;
					proc.kill();
				},
				Math.max(1_000, request.timeoutMs),
			);
			const exitCode = await proc.exited;
			clearTimeout(timer);
			const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			const durationMs = Date.now() - started;
			const parsed = parseMakiOutput(stdout);
			const metrics = metricsFrom(parsed, durationMs);

			if (timedOut) {
				return {
					ok: false,
					error: `Timeout após ${Math.round(durationMs / 1000)}s no maki.`,
					metrics,
					stderr,
					exitCode,
					timedOut: true,
				};
			}
			if (exitCode !== 0 || parsed?.is_error === true) {
				return {
					ok: false,
					error:
						parsed?.result?.trim() ||
						stderr.trim() ||
						`maki saiu com código ${exitCode}.`,
					metrics,
					stderr,
					exitCode,
				};
			}
			if (typeof parsed?.result !== "string" || parsed.result.trim().length === 0) {
				return {
					ok: false,
					error: "maki não retornou `result` (esperado com --output-format json).",
					metrics,
					stderr,
					exitCode,
				};
			}
			return {
				ok: true,
				text: parsed.result,
				metrics,
				stderr,
				exitCode,
			};
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error
						? `Falha ao executar o maki: ${error.message}`
						: `Falha ao executar o maki: ${String(error)}`,
				metrics: { durationMs: Date.now() - started },
				stderr: "",
			};
		}
	}
}

/** Extrai o objeto JSON do stdout do maki (linha única ou objeto completo). */
export function parseMakiOutput(stdout: string): MakiJsonOutput | null {
	const whole = tryParseJson(stdout.trim());
	if (whole.ok && isObject(whole.value)) return whole.value as MakiJsonOutput;

	const lines = stdout.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		const parsed = tryParseJson(line);
		if (parsed.ok && isObject(parsed.value)) return parsed.value as MakiJsonOutput;
	}
	return null;
}

/**
 * Extrai o JSON dos findings da resposta final do agente.
 * Aceita JSON puro, bloco markdown ou objeto cercado por texto.
 */
export function extractJsonObject(text: string): unknown | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;

	const direct = tryParseJson(trimmed);
	if (direct.ok) return direct.value;

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		const parsed = tryParseJson(fenced[1].trim());
		if (parsed.ok) return parsed.value;
	}

	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const parsed = tryParseJson(trimmed.slice(start, end + 1));
		if (parsed.ok) return parsed.value;
	}
	return null;
}

/** Normaliza as métricas do JSON do maki. */
export function metricsFrom(
	output: MakiJsonOutput | null,
	durationMs: number,
): MakiRunMetrics {
	const usage = output?.usage;
	return {
		sessionId: typeof output?.session_id === "string" ? output.session_id : undefined,
		durationMs: numberOr(output?.duration_ms) ?? durationMs,
		numTurns: numberOr(output?.num_turns),
		costUsd: numberOr(output?.total_cost_usd),
		usage: usage
			? {
					inputTokens: numberOr(usage.input_tokens),
					outputTokens: numberOr(usage.output_tokens),
					totalTokens: numberOr(usage.total_tokens),
					cacheReadInputTokens: numberOr(usage.cache_read_input_tokens),
				}
			: undefined,
	};
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}
