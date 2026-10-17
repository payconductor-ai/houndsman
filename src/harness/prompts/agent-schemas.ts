/**
 * Schemas das saídas intermediárias da máquina de estados.
 */

import { z } from "zod";
import { SeveritySchema } from "../../core/ai/schemas";

/** ORIENT: hipóteses iniciais. */
export const OrientOutputSchema = z.object({
	hypotheses: z.array(z.string()).max(8).default([]),
});
export type OrientOutput = z.infer<typeof OrientOutputSchema>;

/** PLAN: tarefas escolhidas do plano determinístico. */
export const PlanOutputSchema = z.object({
	taskIds: z.array(z.string()).default([]),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/** INVESTIGATE: drafts + cobertura. */
export const FindingDraftSchema = z.object({
	rule: z.string(),
	severity: SeveritySchema,
	file: z.string(),
	line: z.number().int().positive().optional(),
	message: z.string(),
	action: z.string(),
	evidenceIds: z.array(z.string()).default([]),
	confidence: z.number().min(0).max(1).default(0.6),
});

export const CoverageOutputSchema = z.object({
	rule: z.string(),
	status: z.enum(["checked", "not_applicable", "skipped"]),
	reason: z.string().optional(),
});

export const InvestigateOutputSchema = z.object({
	findingDrafts: z.array(FindingDraftSchema).default([]),
	coverage: z.array(CoverageOutputSchema).default([]),
});
export type InvestigateOutput = z.infer<typeof InvestigateOutputSchema>;

/** VERIFY: decisão do crítico (opcional; determinístico por default). */
export const CriticOutputSchema = z.object({
	decisions: z
		.array(
			z.object({
				rule: z.string(),
				file: z.string(),
				verdict: z.enum(["keep", "drop", "downgrade"]),
				reason: z.string().optional(),
			}),
		)
		.default([]),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;
