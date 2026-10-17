/**
 * Cache de resultados de tools por execução de agente.
 *
 * Chave = tool + input serializado. Respeita TTL declarado no metadata. Evita
 * reler o mesmo trecho em estados diferentes.
 */

/** Entrada do cache. */
type CacheEntry = { value: unknown; expiresAt: number };

/** Cache em memória (escopo de uma review/agente). */
export class ToolCache {
	private readonly entries = new Map<string, CacheEntry>();

	/** Chave estável (JSON com chaves ordenadas). */
	static key(tool: string, input: unknown): string {
		return `${tool}:${stableStringify(input)}`;
	}

	get<T>(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value as T;
	}

	set(key: string, value: unknown, ttlMs = 60_000): void {
		this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
	}

	clear(): void {
		this.entries.clear();
	}
}

/** Serializa um valor com chaves ordenadas. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const body = Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",");
	return `{${body}}`;
}
