/**
 * Schemas Zod da camada de IA.
 *
 * Espelham os contratos existentes (`ContextSummary`, `WatchdogReport`) e os
 * planos das features. Todo schema é fechado por validação: saída inválida do
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
	objective: z.string().max(200).optional(),
	motivation: z.string().max(240).optional(),
	changeSummary: z.array(z.string().max(160)).max(4).optional(),
});
export type ContextSummaryPlan = z.infer<typeof ContextSummarySchema>;

/** Plano de revisão sugerido por IA para um brief. */
export const BriefPlanSchema = z.object({
	focus: z.array(z.string()).max(5).default([]),
	questions: z.array(z.string()).max(3).default([]),
	risks: z.array(z.string()).max(3).default([]),
	/** Verificações de consistência lógica (fora das regras explícitas). */
	logic: z.array(z.string()).max(3).default([]),
	/** Riscos do domínio de negócio (fora das regras explícitas). */
	domain: z.array(z.string()).max(3).default([]),
});
export type BriefPlan = z.infer<typeof BriefPlanSchema>;

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

/** Relatório de um watchdog (espelha `OUTPUT-FORMAT.md`). */
export const WatchdogReportSchema = z.object({
	watchdogId: z.string(),
	reviewedFiles: z.array(z.string()).default([]),
	skipped: z.array(z.string()).default([]),
	findings: z
		.array(
			z.object({
				rule: z.string(),
				severity: SeveritySchema,
				file: z.string(),
				line: z.number().int().positive().optional(),
				message: z.string(),
				action: z.string(),
				evidence: z.string().optional(),
			}),
		)
		.default([]),
});
export type AiWatchdogReport = z.infer<typeof WatchdogReportSchema>;

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
