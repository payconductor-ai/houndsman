/**
 * Parser de argv do CLI — reexporta a implementação de `core/`.
 *
 * O parser vive em `core/` para ser reutilizado pelos comandos da biblioteca
 * (`parseReviewArgs`) sem inverter a camada `core → cli`.
 */

export { ArgParser } from "../core/arg-parser";
