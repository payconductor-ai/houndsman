/**
 * Indicador de auto-refresh: ponto de pulso (verde estável / âmbar pulsando
 * durante a atualização) + tempo decorrido desde a última sincronização.
 *
 * O tique de 1s vive aqui — a lista de findings não re-renderiza por causa dele.
 */

import { useEffect, useState } from "preact/hooks";
import { formatElapsed } from "./format";

export function AutoRefresh({
	lastSync,
	refreshing,
}: {
	lastSync: number;
	refreshing: boolean;
}) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const seconds = Math.max(0, Math.floor((now - lastSync) / 1000));

	return (
		<span
			class="auto-refresh"
			title="A lista é revalidada automaticamente enquanto esta página estiver aberta"
		>
			<span class={`dot${refreshing ? " busy" : ""}`} />
			{refreshing
				? "Auto-refresh · atualizando…"
				: `Auto-refresh · ${formatElapsed(seconds)}`}
		</span>
	);
}
