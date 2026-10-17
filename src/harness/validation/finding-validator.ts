/**
 * Validação final do relatório de um watchdog.
 *
 * Descarta findings que citam regra inexistente, arquivo fora do domínio/impacto,
 * overflow (não lido) ou linha inválida. `reviewedFiles` só aceita arquivos
 * existentes; overflow entra em `skipped`.
 */

import { readFileSync } from "node:fs";
import type { WatchdogReport } from "../../core/report-builder";
import { emergentText, isEmergentRule } from "../../core/rule-text";
import { SEVERITY_ORDER, type Severity } from "../../core/types";
import { capSeverity } from "../investigation/finding-critic";

/** Contexto de validação. */
export type ValidationContext = {
	watchdogId: string;
	knownRules: ReadonlySet<string>;
	allowedFiles: ReadonlySet<string>;
	overflow: ReadonlySet<string>;
	readFile: (path: string) => string | null;
	/** Aceita findings `Lógica:`/`Domínio:` fora das regras. */
	allowEmergentFindings?: boolean;
};

/** Resultado da validação. */
export type ValidationResult = {
	report: WatchdogReport;
	dropped: { finding: string; reason: string }[];
};

const SEVERITIES = new Set<string>(SEVERITY_ORDER);

/** Validador de relatórios. */
export class FindingValidator {
	private readonly context: ValidationContext;

	constructor(context: ValidationContext) {
		this.context = context;
	}

	/** Valida/normaliza o relatório. */
	validate(report: WatchdogReport): ValidationResult {
		const dropped: { finding: string; reason: string }[] = [];
		const findings = report.findings
			.filter((finding) => {
				const reason = this.reasonToDrop(finding);
				if (!reason) return true;
				dropped.push({
					finding: `${finding.file}:${finding.line ?? "?"}`,
					reason,
				});
				return false;
			})
			.map((finding) =>
				isEmergentRule(finding.rule)
					? {
							...finding,
							severity: capSeverity(finding.severity, "attention"),
						}
					: finding,
			);

		const reviewedFiles = report.reviewedFiles
			.filter((file) => this.context.allowedFiles.has(file))
			.filter((file) => this.context.readFile(file) !== null);

		const skipped = new Set(report.skipped);
		for (const file of this.context.overflow) skipped.add(`${file} (budget)`);

		return {
			report: {
				watchdogId: this.context.watchdogId,
				reviewedFiles: [...new Set(reviewedFiles)],
				skipped: [...skipped],
				findings,
			},
			dropped,
		};
	}

	/** Motivo para descartar (ou `null` se válido). */
	private reasonToDrop(finding: {
		rule: string;
		severity: Severity;
		file: string;
		line?: number;
	}): string | null {
		if (isEmergentRule(finding.rule)) {
			if (!this.context.allowEmergentFindings)
				return "finding emergente desabilitado";
			if (!emergentText(finding.rule)) return "finding emergente sem descrição";
		} else if (!this.context.knownRules.has(finding.rule.trim())) {
			return "regra inexistente";
		}
		if (!SEVERITIES.has(finding.severity)) return "severidade inválida";
		if (this.context.overflow.has(finding.file)) return "arquivo fora do orçamento";
		if (!this.context.allowedFiles.has(finding.file))
			return "arquivo fora do domínio";
		const content = this.context.readFile(finding.file);
		if (content === null) return "arquivo ausente";
		if (finding.line !== undefined) {
			const total = content.split("\n").length;
			if (finding.line < 1 || finding.line > total) return "linha fora do arquivo";
		}
		return null;
	}
}

/** Leitor de arquivos padrão (UTF-8; `null` se ausente). */
export function defaultFileReader(root: string): (path: string) => string | null {
	return (path: string) => {
		try {
			return readFileSync(`${root}/${path}`, "utf8");
		} catch {
			return null;
		}
	};
}
