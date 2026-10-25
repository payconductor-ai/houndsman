/**
 * Schemas Zod da camada de IA.
 *
 * Espelham os contratos existentes (`ContextSummary`) e os planos das features. Todo schema é fechado por validação: saída inválida do
 * modelo vira falha fail-open, nunca dado corrompido.
 */

import { z } from "zod";

export const SeveritySchema = z.enum(["blocking", "attention", "suggestion", "nit"]);

/** Resumo da PR (`context-summary.json`). */
export const ContextSummarySchema = z.object({
	available: z.boolean(),
	source: z
		.object({
			number: z.number().optional(),
			title: z.string().optional(),
			url: z.string().optional(),
			base: z.string().optional(),
			head: z.string().optional(),
		})
		.optional(),
	objective: z.string().max(400).optional(),
	motivation: z.string().max(480).optional(),
	changeSummary: z.array(z.string().max(240)).max(6).optional(),
});
export type ContextSummaryPlan = z.infer<typeof ContextSummarySchema>;

/** Pontos técnicos estruturais do resumo final (`technical-summary.json`). */
export const TechnicalSummarySchema = z.object({
	/** Parágrafo curto de abertura (opcional). */
	overview: z.string().max(600).optional(),
	highlights: z
		.array(
			z.object({
				area: z.string().min(1).max(80),
				detail: z.string().min(1).max(400),
			}),
		)
		.max(8)
		.default([]),
});
export type TechnicalSummaryPlan = z.infer<typeof TechnicalSummarySchema>;

/** Verificação sugerida — sempre ancorada em arquivo/símbolo quando possível. */
export const BriefCheckSchema = z.object({
	statement: z.string().min(1).max(240),
	file: z.string().max(200).optional(),
	symbol: z.string().max(120).optional(),
	/** Invariante que a verificação protege (`domain`). */
	invariant: z.string().max(200).optional(),
});
export type BriefCheck = z.infer<typeof BriefCheckSchema>;

/** Plano de revisão sugerido por IA para um brief. */
export const BriefPlanSchema = z.object({
	focus: z.array(z.string()).max(5).default([]),
	questions: z.array(z.string()).max(3).default([]),
	risks: z.array(z.string()).max(3).default([]),
	/** Verificações de consistência lógica (fora das regras explícitas). */
	logic: z.array(BriefCheckSchema).max(4).default([]),
	/** Riscos do domínio de negócio (fora das regras explícitas). */
	domain: z.array(BriefCheckSchema).max(4).default([]),
});
export type BriefPlan = z.infer<typeof BriefPlanSchema>;

/** Modelo de intenção da PR (`business-summary.json`). */
export const BusinessSummarySchema = z.object({
	intent: z.string().max(800).optional(),
	flows: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				trigger: z.string().max(240).optional(),
				expected: z.string().max(400).optional(),
				files: z.array(z.string().max(200)).max(20).optional(),
			}),
		)
		.max(12)
		.default([]),
	invariants: z.array(z.string().max(300)).max(12).default([]),
	contracts: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				sides: z.array(z.string().max(160)).max(8).optional(),
				expectation: z.string().max(400).optional(),
			}),
		)
		.max(12)
		.default([]),
	states: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				transitions: z.array(z.string().max(200)).max(12).optional(),
			}),
		)
		.max(8)
		.default([]),
	nonGoals: z.array(z.string().max(240)).max(8).optional(),
	openQuestions: z.array(z.string().max(300)).max(8).optional(),
});
export type BusinessSummaryPlan = z.infer<typeof BusinessSummarySchema>;

/** Hipóteses de lógica/domínio (candidatos, nunca achados). */
export const BusinessHypothesesSchema = z.object({
	hypotheses: z
		.array(
			z.object({
				file: z.string().min(1),
				kind: z.enum(["logic", "domain"]),
				statement: z.string().min(1).max(300),
				invariant: z.string().max(200).optional(),
				confidence: z.number().min(0).max(1),
			}),
		)
		.max(12)
		.default([]),
});
export type BusinessHypothesis = z.infer<
	typeof BusinessHypothesesSchema
>["hypotheses"][number];

/** Classificação de arquivos não classificados. */
export const ClassificationSchema = z.object({
	assignments: z
		.array(
			z.object({
				file: z.string(),
				watchdogId: z.string(),
				confidence: z.number().min(0).max(1).optional(),
			}),
		)
		.max(200)
		.default([]),
});
export type AiClassification = z.infer<typeof ClassificationSchema>;

/** Candidato de pré-análise (`JevCandidate`-like). */
export const CandidateSchema = z.object({
	candidates: z
		.array(
			z.object({
				file: z.string(),
				watchdogId: z.string(),
				rule: z.string(),
				severity: SeveritySchema,
				confidence: z.number().min(0).max(1),
				reason: z.string().optional(),
			}),
		)
		.max(200)
		.default([]),
});
export type AiCandidate = z.infer<typeof CandidateSchema>["candidates"][number];

/** Veredito de verificação (confirma/refuta um finding ambíguo). */
export const VerifySchema = z.object({
	verdicts: z
		.array(
			z.object({
				id: z.string(),
				persisting: z.boolean(),
				confidence: z.number().min(0).max(1),
				reason: z.string().optional(),
			}),
		)
		.default([]),
});
export type AiVerdict = z.infer<typeof VerifySchema>["verdicts"][number];
