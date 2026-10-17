/**
 * Relógio injetável (biblioteca) — timestamps ISO 8601.
 *
 * Centraliza `new Date().toISOString()` para que o domínio não dependa do
 * relógio do sistema e os testes possam congelar o tempo.
 */

/** Devolve um timestamp ISO 8601. */
export type Clock = () => string;

/** Relógio do sistema (default do motor). */
export const systemClock: Clock = () => new Date().toISOString();
