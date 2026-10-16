/**
 * Lista de findings agrupada por severidade (blocking > attention > suggestion > nit).
 */

import { useMemo } from "preact/hooks";
import { SEVERITY_LABELS, SEVERITY_ORDER } from "./constants";
import { FindingCard } from "./FindingCard";
import { Alert } from "./icons";
import type { Finding, Severity } from "./types";

export function FindingsList({
	slug,
	findings,
	onUpdated,
}: {
	slug: string;
	findings: Finding[];
	onUpdated: (finding: Finding) => void;
}) {
	const grouped = useMemo(() => {
		const bySeverity = new Map<Severity, Finding[]>();
		for (const severity of SEVERITY_ORDER) bySeverity.set(severity, []);
		for (const finding of findings) bySeverity.get(finding.severity)?.push(finding);
		return bySeverity;
	}, [findings]);

	if (findings.length === 0) {
		return <p class="empty">Nenhum finding para os filtros.</p>;
	}

	return (
		<>
			{SEVERITY_ORDER.map((severity) => {
				const items = grouped.get(severity) ?? [];
				if (items.length === 0) return null;
				return (
					<section class={`sev-group sev-${severity}`} key={severity}>
						<h2 class="sev-head">
							<Alert size={14} />
							{SEVERITY_LABELS[severity]}
							<span class="n">{items.length}</span>
						</h2>
						{items.map((finding) => (
							<FindingCard
								key={finding.id}
								slug={slug}
								finding={finding}
								onUpdated={onUpdated}
							/>
						))}
					</section>
				);
			})}
		</>
	);
}
