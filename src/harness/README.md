# `src/harness` — harness nativo do houndsman

Este diretório é o **runtime de agentes do próprio houndsman** (`houndsman hunt`):
tools read-only, investigação, máquina de estados e o agente revisor.

> O **harness externo** (skill `/houndsman` para ClaudeCode/Copilot/agents) continua em
> `src/skill/`. Os dois coexistem; o nativo é opt-in.

Regras de dependência:

- `harness/` pode importar `core/` (inclusive `core/ai`).
- `core/` **nunca** importa `harness/`.
- `cli/` importa ambos.

Documentação detalhada: [`docs/HARNESS.md`](../../docs/HARNESS.md).
