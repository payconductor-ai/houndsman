/**
 * Subcomando default — parse de flags + prepare/finalize.
 *
 * Biblioteca: NÃO usa `process.argv`/`process.exit` (o CLI decide o exit code).
 */

import { ArgParser } from "../arg-parser";
import { defaultOptions, type ReviewOptions } from "../orchestrator";
import { ARTIFACT_DIR } from "../paths";

/** Converte argv (sem o subcomando) nas opções de prepare/finalize. */
export function parseReviewArgs(
	args: string[],
	artifactDir: string = ARTIFACT_DIR,
): ReviewOptions {
	const parser = ArgParser.from(args);
	const opts = defaultOptions(artifactDir);

	const base = parser.value("--base");
	const head = parser.value("--head");
	const branch = parser.value("--branch");
	const dir = parser.value("--dir");
	if (base) opts.base = base;
	if (head) opts.head = head;
	if (branch) opts.branch = branch;
	if (dir) opts.dir = dir;

	if (parser.has("--finalize") || parser.has("--report-only")) opts.finalize = true;
	if (parser.has("--fail-on-blocking")) opts.failOnBlocking = true;
	if (parser.has("--clean")) opts.clean = true;
	if (parser.has("--no-jev")) opts.noJev = true;
	if (parser.has("--full")) opts.full = true;

	return opts;
}
