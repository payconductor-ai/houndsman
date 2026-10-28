import { describe, expect, test } from "bun:test";
import { anchorContentKey, buildAnchor } from "../core/finding-anchor";
import {
	isDistinctAnchor,
	isNearDuplicate,
	occurrenceKey,
	outweighs,
	ruleIdentityKey,
} from "../core/finding-identity";
import {
	dedupeFindings,
	dedupeFindingsWithStats,
	type Finding,
	nearbyDuplicateGroups,
	type WatchdogReport,
} from "../core/report-builder";

/** Conteúdo-alvo dos testes (duas funções com a mesma linha ofensora). */
const SOURCE = [
	"export function pay() {",
	'\tconsole.log("debug");',
	"}",
	"",
	"export function refund() {",
	'\tconsole.log("debug");',
	"}",
].join("\n");

function finding(partial: Partial<Finding> & { rule: string; file: string }): Finding {
	return {
		severity: "attention",
		message: "mensagem",
		action: "ação",
		...partial,
	};
}

function report(watchdogId: string, findings: Finding[]): WatchdogReport {
	return { watchdogId, reviewedFiles: [], skipped: [], findings };
}

const reader = (file: string): string | null => (file === "src/pay.ts" ? SOURCE : null);

describe("ruleIdentityKey", () => {
	test("ignora caixa, acento e pontuação", () => {
		expect(ruleIdentityKey("Evitar console.log.")).toBe(
			ruleIdentityKey("evitar   CONSOLE log"),
		);
		expect(ruleIdentityKey("Não expor credencial")).toBe(
			ruleIdentityKey("nao expor credencial"),
		);
	});

	test("remove o prefixo reservado de achado emergente", () => {
		expect(ruleIdentityKey("Lógica: falta validação")).toBe(
			ruleIdentityKey("Domínio: falta validação"),
		);
		expect(ruleIdentityKey("Lógica: falta validação")).toBe("falta validacao");
	});

	test("remove a numeração do brief e reticências de truncamento", () => {
		expect(ruleIdentityKey("Regra 3 — Evitar console.log")).toBe(
			ruleIdentityKey("3. evitar console.log"),
		);
		expect(ruleIdentityKey("Evitar console.log…")).toBe("evitar console log");
	});

	test("mantém número que faz parte do texto", () => {
		expect(ruleIdentityKey("Status 200 não tratado")).toBe("status 200 nao tratado");
	});
});

describe("occurrenceKey", () => {
	test("ignora a linha e normaliza o caminho", () => {
		const a = occurrenceKey({ file: "./src/pay.ts", rule: "Regra 1 — Evitar X" });
		const b = occurrenceKey({ file: "src\\pay.ts", rule: "evitar x" });
		expect(a).toBe(b);
	});

	test("não gera chave vazia para regra só de pontuação", () => {
		const key = occurrenceKey({ file: "a.ts", rule: "—" });
		expect(key).toBe("a.ts|—");
	});
});

describe("isDistinctAnchor", () => {
	test("rejeita ruído de sintaxe e aceita código real", () => {
		expect(isDistinctAnchor("}")).toBe(false);
		expect(isDistinctAnchor("return")).toBe(false);
		expect(isDistinctAnchor('console.log("debug");')).toBe(true);
	});
});

describe("outweighs", () => {
	test("regra declarada vence achado emergente de severidade maior", () => {
		expect(
			outweighs(
				{ severity: "suggestion", basis: "rule" },
				{ severity: "blocking", basis: "logic" },
			),
		).toBe(true);
	});

	test("na mesma origem, vence a severidade mais grave", () => {
		expect(
			outweighs(
				{ severity: "blocking", basis: "rule" },
				{ severity: "attention", basis: "rule" },
			),
		).toBe(true);
		expect(
			outweighs(
				{ severity: "attention", basis: "rule" },
				{ severity: "blocking", basis: "rule" },
			),
		).toBe(false);
	});
});

describe("dedupeFindings", () => {
	test("mesma regra em várias linhas do arquivo é UM achado com ocorrências", () => {
		const reports = [
			report("alpha", [
				finding({ file: "src/pay.ts", line: 2, rule: "Evitar console.log" }),
			]),
			report("beta", [
				finding({ file: "src/pay.ts", line: 6, rule: "Evitar console.log" }),
				finding({ file: "./src/pay.ts", line: 6, rule: "Evitar console.log" }),
			]),
		];

		const { findings, stats } = dedupeFindingsWithStats(reports);
		expect(findings).toHaveLength(1);
		expect(findings[0].occurrences).toBe(3);
		expect(findings[0].watchdogs).toEqual(["alpha", "beta"]);
		expect(findings[0].line).toBe(2);
		expect(stats.collapsedByRule).toBe(2);
		expect(stats.collapsedByAnchor).toBe(0);
	});

	test("texto de regra reescrito entre watchdogs casa", () => {
		const reports = [
			report("alpha", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Regra 3 — Evitar console.log.",
				}),
			]),
			report("general", [
				finding({
					file: "src/pay.ts",
					line: 6,
					rule: "Lógica: evitar CONSOLE log",
					basis: "logic",
				}),
			]),
		];
		expect(dedupeFindings(reports)).toHaveLength(1);
	});

	test("regra declarada representa o achado (prefiro a versão com regra)", () => {
		const reports = [
			report("general", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Lógica: Evitar console.log",
					basis: "logic",
					severity: "blocking",
					message: "emergente",
				}),
			]),
			report("alpha", [
				finding({
					file: "src/pay.ts",
					line: 6,
					rule: "Evitar console.log",
					severity: "suggestion",
					message: "regra",
				}),
			]),
		];

		const [merged] = dedupeFindings(reports);
		expect(merged.rule).toBe("Evitar console.log");
		expect(merged.message).toBe("regra");
		expect(merged.watchdogs).toEqual(["general", "alpha"]);
		expect(merged.occurrences).toBe(2);
	});

	test("dois emergentes no mesmo trecho colapsam (camada por âncora)", () => {
		const reports = [
			report("general", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Lógica: log de debug esquecido no fluxo de pagamento",
					basis: "logic",
				}),
			]),
			report("alpha", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Domínio: log cru no caminho de cobrança",
					basis: "domain",
				}),
			]),
		];

		const { findings, stats } = dedupeFindingsWithStats(reports, {
			readFile: reader,
		});
		expect(findings).toHaveLength(1);
		expect(stats.collapsedByAnchor).toBe(1);
		expect(findings[0].watchdogs).toEqual(["general", "alpha"]);
	});

	test("emergente × regra no mesmo trecho não colapsa (assuntos distintos)", () => {
		const reports = [
			report("alpha", [
				finding({ file: "src/pay.ts", line: 2, rule: "Evitar console.log" }),
			]),
			report("general", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Domínio: sentAmount vem da adquirente sem validação de faixa",
					basis: "domain",
				}),
			]),
		];

		expect(
			dedupeFindingsWithStats(reports, { readFile: reader }).findings,
		).toHaveLength(2);
	});

	test("duas regras declaradas no mesmo trecho continuam sendo dois achados", () => {
		const reports = [
			report("alpha", [
				finding({ file: "src/pay.ts", line: 2, rule: "Evitar console.log" }),
			]),
			report("beta", [
				finding({
					file: "src/pay.ts",
					line: 2,
					rule: "Promover: log estruturado",
				}),
			]),
		];

		expect(
			dedupeFindingsWithStats(reports, { readFile: reader }).findings,
		).toHaveLength(2);
	});

	test("não colapsa trechos diferentes do mesmo arquivo", () => {
		const reports = [
			report("alpha", [
				finding({ file: "src/pay.ts", line: 2, rule: "Evitar console.log" }),
			]),
			report("general", [
				finding({
					file: "src/pay.ts",
					line: 6,
					rule: "Lógica: log esquecido no estorno",
					basis: "logic",
				}),
			]),
		];

		expect(
			dedupeFindingsWithStats(reports, { readFile: reader }).findings,
		).toHaveLength(2);
	});

	test("achados sem âncora (arquivo ilegível) nunca são descartados", () => {
		const reports = [
			report("alpha", [
				finding({ file: "src/ausente.ts", line: 2, rule: "Evitar console.log" }),
			]),
			report("general", [
				finding({
					file: "src/ausente.ts",
					line: 3,
					rule: "Lógica: log esquecido",
					basis: "logic",
				}),
			]),
		];

		expect(
			dedupeFindingsWithStats(reports, { readFile: reader }).findings,
		).toHaveLength(2);
	});

	test("a âncora usada no dedupe é a mesma de `finding-anchor`", () => {
		const anchor = buildAnchor(SOURCE, 2);
		expect(anchor).not.toBeNull();
		if (!anchor) return;
		expect(anchorContentKey(anchor)).toContain('console.log("debug");');
	});
});

describe("paráfrases entre watchdogs", () => {
	const fallback =
		"No fallback de parse, não assumir o valor integral: registrar o envio sem amount definitivo e deixar a reconciliação ajustar o saldo.";

	test("mesmo defeito descrito por outro watchdog é reconhecido", () => {
		expect(
			isNearDuplicate(
				{
					file: "src/pay.ts",
					line: 10,
					message:
						"Com allowPartialAmount ativo, o fallback de safeParse inválido continua registrando o valor integral enviado.",
					action: fallback,
				},
				{
					file: "src/pay.ts",
					line: 20,
					message:
						"Com allowPartialAmount habilitado, o caminho de safeParse com falha continua registrando o valor integral enviado.",
					action: fallback,
				},
			),
		).toBe(true);
	});

	test("mesmo trecho com assunto diferente não é reconhecido", () => {
		expect(
			isNearDuplicate(
				{
					file: "src/pay.ts",
					line: 10,
					message:
						"A decisão de qual valor foi enviado ficou embutida em sendWithdraw, que mistura banco e HTTP: não há teste isolado.",
					action: "Extrair a resolução do valor para uma função pura exportada e testá-la.",
				},
				{
					file: "src/pay.ts",
					line: 10,
					message:
						"O valor devolvido pela adquirente entra sem validação de faixa e pode superar o autorizado.",
					action: "Validar a faixa aceita antes de persistir; fora dela, tratar como resposta inconsistente.",
				},
			),
		).toBe(false);
	});

	test("agrupa paráfrases sem mesclar os achados", () => {
		const reports = [
			report("withdraw-flows", [
				finding({
					file: "src/pay.ts",
					line: 10,
					rule: "Promover: falha parcial preserva o estado financeiro",
					message:
						"Com allowPartialAmount ativo, o fallback de safeParse inválido continua registrando o valor integral enviado.",
					action: fallback,
				}),
			]),
			report("acquirer-integrations", [
				finding({
					file: "src/pay.ts",
					line: 20,
					rule: "Payload e status recebidos do adquirente são normalizados",
					message:
						"Com allowPartialAmount habilitado, o caminho de safeParse com falha continua registrando o valor integral enviado.",
					action: fallback,
				}),
			]),
		];

		const merged = dedupeFindings(reports, { readFile: reader });
		expect(merged).toHaveLength(2);
		const groups = nearbyDuplicateGroups(merged);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toHaveLength(2);
	});
});
