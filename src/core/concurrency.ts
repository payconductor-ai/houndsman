/**
 * Pool de concorrência mínimo (biblioteca).
 *
 * Mantém no máximo `limit` promessas ativas e preserva a ordem dos resultados.
 * Não trata erros: o chamador decide se cada item falha isoladamente.
 */

/** Executa `mapper` para cada item com concorrência limitada. */
export async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	if (items.length === 0) return results;

	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await mapper(items[index], index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}
