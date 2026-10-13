---
name: houndsman
description: 'Revisa Pull Requests com watchdogs especializados por domínio de negócio e mantém essas regras alinhadas ao projeto. Use para revisar/code review de PR, atualizar as regras de revisão dos watchdogs e corrigir/verificar os findings da revisão. Capabilities: `hunt` (revisar a PR), `train` (atualizar regras), `fix` (corrigir achados), `verify` (violações resolvidas?).'
argument-hint: 'Capability: hunt | train | fix | verify (default: hunt)'
---

# houndsman — {{projectName}}

O **houndsman** revisa Pull Requests com **watchdogs** — agentes especialistas por domínio de
negócio. Cada watchdog audita a parte do diff que é sua e grava **findings** (achados); o motor
consolida tudo num relatório. O motor é o CLI **`houndsman`**; as regras do projeto vivem em
`houndsman.config.ts` + `.houndsman/`.

**Terminologia:** **houndsman** = orquestrador/treinador (CLI + motor) · **watchdog** = agente
especialista por domínio · **finding** = um achado da revisão · **Jev** = pré-análise opcional.

## Capabilities

| Capability | Objetivo | Documento |
|---|---|---|
| **`hunt`** | Revisar uma Pull Request e produzir o relatório de achados. | `.houndsman/core/skill/hunt.md` |
| **`train`** | Manter as regras dos watchdogs alinhadas ao que o projeto aplica. | `.houndsman/core/skill/train.md` |
| **`fix`** | Corrigir os achados de uma revisão já finalizada. | `.houndsman/core/skill/fix.md` |
| **`verify`** | Conferir se as violações foram resolvidas, sem re-revisar a PR. | `.houndsman/core/skill/verify.md` |

## Invocação

```
/houndsman              → hunt (default)
/houndsman hunt         → revisar a Pull Request
/houndsman train        → atualizar as regras dos watchdogs
/houndsman fix          → corrigir os findings
/houndsman verify       → conferir se as violações foram resolvidas
```

Um argumento extra é o alvo da capability (ex.: `/houndsman hunt feature/minha-branch`).
Escolha a capability pelo que o usuário quer, leia o documento correspondente em
`.houndsman/core/skill/<capability>.md` e siga-o.

> **Depois de revisar (`hunt`), valide na UI:** `bun run houndsman server --open` — revise os
> achados e marque os que devem ser executados (`execute`) antes de rodar `fix`.

## Referências

- `.houndsman/core/skill/OUTPUT-FORMAT.md` — schema do JSON de saída dos watchdogs.
- `.houndsman/core/skill/AUDIT-PROTOCOL.md` — taxonomia da auditoria de regras (Modo B do `train`).
- `.houndsman/core/skill/SETUP.md` · `.houndsman/core/skill/README.md` — configuração e visão geral.
- `.houndsman/core/skill/example-review.md` — exemplo de relatório.
