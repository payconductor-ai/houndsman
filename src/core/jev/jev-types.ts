/**
 * Tipos da API TypeSafe "System One" (modelo Jev).
 *
 * Contrato: `POST {baseURL}/v1/systemone`
 *   Body: { state, model?, questions: Record<key, JevQuestion> }
 *   Resp: { model, answers: Record<key, JevAnswer>, usage? }
 *
 * Cada pergunta é avaliada em paralelo e em isolamento contra o mesmo `state`.
 */

/** Tipo de pergunta aceito pela API. */
export type JevQuestionType = "noul" | "choice" | "score";

/** "A afirmação é verdadeira?" → retorna probabilidade 0–1. */
export type JevNoulQuestion = {
	type: "noul";
	instructions: string;
};

/** Escolhe uma opção de uma lista. */
export type JevChoiceQuestion = {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
};

/** Pontua o estado em uma rubrica (índice da lista). */
export type JevScoreQuestion = {
	type: "score";
	instructions: string;
	criteria: string[];
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevEvaluateRequest = {
	state: string;
	model?: string;
	questions: Record<string, JevQuestion>;
};

export type JevNoulAnswer = {
	type: "noul";
	noul: number;
};

export type JevChoiceAnswer = {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
};

export type JevScoreAnswer = {
	type: "score";
	score: number;
	confidence: number;
	legend?: Record<string, string>;
	probabilities?: Record<string, number>;
};

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevUsage = {
	input_tokens?: number;
	output_tokens?: number;
};

export type JevEvaluateResponse = {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: JevUsage;
};

/**
 * Spec de conversão de uma regra do registry em pergunta Jev.
 *
 * Sempre um objeto — `kind` é obrigatório para deixar explícito o que a spec
 * faz (a presença de `jev` não é um liga/desliga do Jev).
 *
 * - `kind: "noul"`   → "a violação descrita ocorre?" (probabilidade 0–1).
 * - `kind: "choice"` → escolha entre opções (`criteria` obrigatório, objeto).
 * - `kind: "score"`  → nota numa rubrica (`criteria` obrigatório, lista).
 *
 * `instructions` omitida → derivada da própria descrição da regra.
 */
export type JevRuleSpec = {
	kind: JevQuestionType;
	instructions?: string;
	criteria?: string[] | Record<string, string>;
};
