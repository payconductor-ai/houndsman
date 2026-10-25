/** SHA curto para logs (7 chars, como o git). */
export function shortSha(sha: string): string {
	return sha.slice(0, 7);
}
