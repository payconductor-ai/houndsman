/**
 * Subcomando default — parse de flags + prepare/finalize.
 *
 * Biblioteca: NÃO usa `process.argv`/`process.exit` (o CLI decide o exit code).
 */

import { defaultOptions, type ReviewOptions } from "../orchestrator";
import { ARTIFACT_DIR } from "../paths";

const VALUE_FLAGS = new Set(["--base", "--head", "--branch", "--dir"]);
const BOOLEAN_FLAGS = new Set([
	"--finalize",
	"--report-only",
	"--fail-on-blocking",
	"--clean",
	"--no-jev",
]);

function applyValue(opts: ReviewOptions, flag: string, value: string | undefined): void {
	if (!value) return;
	if (flag === "--base") opts.base = value;
	else if (flag === "--head") opts.head = value;
	else if (flag === "--branch") opts.branch = value;
	else if (flag === "--dir") opts.dir = value;
}

function applyBoolean(opts: ReviewOptions, flag: string): void {
	if (flag === "--finalize" || flag === "--report-only") opts.finalize = true;
	else if (flag === "--fail-on-blocking") opts.failOnBlocking = true;
	else if (flag === "--clean") opts.clean = true;
	else if (flag === "--no-jev") opts.noJev = true;
}

/** Converte argv (sem o subcomando) nas opções de prepare/finalize. */
export function parseReviewArgs(
	args: string[],
	artifactDir: string = ARTIFACT_DIR,
): ReviewOptions {
	const opts = defaultOptions(artifactDir);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (VALUE_FLAGS.has(arg)) {
			applyValue(opts, arg, args[i + 1]);
			i++;
		} else if (BOOLEAN_FLAGS.has(arg)) {
			applyBoolean(opts, arg);
		}
	}
	return opts;
}
