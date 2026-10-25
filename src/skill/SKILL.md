---
name: houndsman
description: 'Revisa Pull Requests com watchdogs especializados por domínio de negócio e mantém essas regras alinhadas ao projeto. Use para revisar/code review de PR, atualizar as regras de revisão dos watchdogs e corrigir/verificar os findings da revisão. Quando o alvo é uma PR (#456, “PR 456” ou URL do GitHub), revisa em worktree isolado automaticamente. Capabilities: `hunt` (revisar a PR), `train` (atualizar regras), `fix` (corrigir achados), `verify` (violações resolvidas?).'
argument-hint: 'Capability e alvo: hunt --pr 456 | hunt feature/x | train | fix | verify (default: hunt)'
---

# houndsman — {{projectName}}

O **houndsman** revisa Pull Requests com **watchdogs** — agentes especialistas por domínio de
negócio. Cada watchdog audita a parte do diff que é sua e grava **findings** (achados); o motor
consolida tudo num relatório. O motor é o CLI **`houndsman`**; as regras do projeto vivem em
`houndsman.config.ts` + `.houndsman/`.

**Terminologia:** **houndsman** = orquestrador/treinador (CLI + motor) · **watchdog** = agente
especialista por domínio · **finding** = um achado da revisão · **Jev** = pré-análise opcional.

> **Duas etapas são obrigatórias em toda revisão:** o **modelo de intenção**
> (`business-summary.json`) e o revisor de fluxo **`general`** (id reservado, sempre ativo).
> O modelo vem da IA no prepare quando há chave; sem chave, um subagente (Passo 1.5) ou o
> pré-passe maki o produz. Nenhum dos dois é configurável pelo usuário.

## Capabilities

| Capability | Objetivo | Documento |
|---|---|---|
| **`hunt`** | Revisar uma Pull Request e produzir o relatório de achados. | `.houndsman/core/skill/hunt.md` |
| **`train`** | Manter as regras dos watchdogs alinhadas ao que o projeto aplica. | `.houndsman/core/skill/train.md` |
| **`fix`** | Corrigir os achados de uma revisão já finalizada. | `.houndsman/core/skill/fix.md` |
| **`verify`** | Conferir se as violações foram resolvidas, sem re-revisar a PR. | `.houndsman/core/skill/verify.md` |

## Invocação

```
/houndsman                          → hunt (default)
/houndsman hunt                     → revisar a Pull Request
/houndsman hunt, revise a pr 456    → hunt da PR 456 (worktree automático)
/houndsman hunt feature/minha-branch → hunt da branch (clone atual)
/houndsman train                    → atualizar as regras dos watchdogs
/houndsman fix                      → corrigir os findings
/houndsman verify                   → conferir se as violações foram resolvidas
```

Um argumento extra é o alvo da capability. Escolha a capability pelo que o usuário quer,
leia o documento correspondente em `.houndsman/core/skill/<capability>.md` e siga-o.

> **Harness local (opcional):** para rodar sem agente externo, o operador pode instalar o
> maki (`houndsman hunt install`) e usar `houndsman hunt --pr 456`. Isso não muda esta
> skill: se você é o agente, siga o fluxo normal e não rode `houndsman hunt`.

### Alvo da revisão (PR × branch)

Interprete o alvo em linguagem natural **antes** de rodar o CLI:

| O usuário disse | Alvo | Flags |
|---|---|---|
| `PR 456`, `#456`, `pull 456`, `456` (número sozinho), `https://github.com/org/repo/pull/456` | PR | `--pr 456` |
| `feature/minha-branch`, `branch feature/x` | branch | `--branch feature/minha-branch` |
| nada | branch atual | *(sem flag)* |

> **PR citada ⇒ worktree obrigatório.** Nunca rode `houndsman` “puro” para revisar uma PR que o
> usuário nomeou: o prepare precisa criar o worktree dedicado. Também **nunca** faça
> `git checkout` da PR no clone principal — é isso que permite revisar várias PRs ao mesmo
> tempo.

Sequência para uma PR (ex.: 456):

```bash
houndsman --pr 456                 # cria/reusa o worktree, coleta o contexto e prepara
# despache os briefs em paralelo (cada um traz **Worktree:** <path>)
houndsman --pr 456 --finalize
```

- O contexto da PR é coletado pelo próprio prepare (via `gh`); com IA ligada ele também é
  resumido ali — não gaste um subagente nisso. Desative com `--no-context`.
- Para comparar duas execuções, use `--variant <label>` em cada uma e depois
  `houndsman compare --branch <head> --a <a> --b <b>` (ou `compare --list`).

- O worktree vive em `<repo>/.houndsman/worktrees/<repo>/<branch>` (detached no commit da PR)
  e é reutilizado nas próximas execuções da mesma branch. Ele fica **dentro do workspace**
  (e o staging também) para o agente ler/executar sem prompts de permissão.
- Use `--worktree <path>` para aproveitar um worktree já existente.
- O prepare imprime `PR #456 — <head> → <base>`; use `<head>` em `status ping`,
  `findings` e `verify` (`--branch <head>`). A review guarda o worktree, então esses
  comandos leem a árvore correta.
- PR de fork também funciona: o CLI busca `refs/pull/<n>/head`.

> **Depois de revisar (`hunt`), valide na UI:** `bun run houndsman server --open` — revise os
> achados e marque os que devem ser executados (`execute`) antes de rodar `fix`.

## Referências

- `.houndsman/core/skill/OUTPUT-FORMAT.md` — schema do JSON de saída dos watchdogs.
- `.houndsman/core/skill/AUDIT-PROTOCOL.md` — taxonomia da auditoria de regras (Modo B do `train`).
- `.houndsman/core/skill/SETUP.md` · `.houndsman/core/skill/README.md` — configuração e visão geral.
- `.houndsman/core/skill/example-resume.md` — exemplo do resumo final.
