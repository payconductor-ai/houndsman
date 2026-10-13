/**
 * Barrel do módulo Jev (pré-análise do houndsman — Passo 1.5).
 *
 * Consumidores importam daqui (`"./jev"`). Tudo relacionado ao Jev vive nesta
 * pasta — nada solto em `core/`.
 */

export * from "./jev-candidates";
export * from "./jev-client";
export * from "./jev-detector";
export * from "./jev-questions";
export * from "./jev-types";
export * from "./jev-verify";
