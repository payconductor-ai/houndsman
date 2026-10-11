# AGENTS.md — houndsman

> Documentação, comentários e revisões em **português**.
> Mensagens de commit em **inglês**.
> Código-fonte (variáveis, funções, classes) em **inglês**.
> Seja sucinto nos outputs explicativos e comentários.

## Projeto

`houndsman` é um **CLI independente** que revisa Pull Requests: classifica o diff por domínio,
despacha revisores especializados (um subagente por brief) e consolida um relatório.

O motor é **genérico e agnóstico ao projeto** — nenhuma regra, path ou nome de consumidor vive
aqui. O consumidor fornece a configuração em `houndsman.config.ts` + `.houndsman/` (camada de
projeto **autocontida**), carregada em runtime.

- **Runtime:** Bun (obrigatório). O `bin` usa shebang `#!/usr/bin/env bun`.
- **Deps de produção:** apenas `axios` (cliente da pré-análise Jev).
- **Publicação:** npm público, sem escopo (`houndsman`).

## Comandos

| Comando | Função |
| --- | --- |
| `bun run test` | Suíte da lib (project-agnóstica; usa `src/tests/fixtures/fake-project.ts`) |
| `bun run ci` | `biome ci .` + `tsc -b` |
| `bun run ci:fix` | Corrige lint/format/imports — **rode antes de `ci`** |
| `bun run typecheck` | `tsc -b` |
| `bun run lint` / `bun run format` | Biome |
| `bun run build` | `bun build` → `dist/` (bundle único) |
| `bun run houndsman -- <args>` | Executa o CLI localmente |
| `bun publish --dry-run` | Confere o que vai no tarball |

> Fluxo obrigatório: **`bun run ci:fix` → `bun run ci` → `bun run test`**.
> `ci` isolado costuma falhar por formatação — sempre aplique o `ci:fix` primeiro.

## Arquitetura

```
src/
├── index.ts          # API pública (defineReviewer, defineReviewConfig, tipos)
├── cli/index.ts      # ÚNICO executável (bin `houndsman`)
├── core/             # bibliotecas genéricas
│   ├── config.ts            # contrato ReviewConfig + defineReviewConfig
│   ├── config-loader.ts     # descobre/carrega houndsman.config.* em runtime
│   ├── assets.ts            # assets embarcados (src/skill/) — usados para gerar a camada
│   ├── paths.ts             # layout fixo da camada (.houndsman/) + relFromRoot
│   ├── types.ts             # Severity, Rule, ReviewerDefinition, defineReviewer
│   ├── reviewer-registry.ts # getReviewer/findReviewer/getReviewerContext(config)
│   ├── orchestrator.ts      # prepare/finalize
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── file-classifier.ts   # classificação via `classify` dos revisores
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── pr-context.ts        # contexto da PR via `gh`
│   ├── commands/            # context · review · reviewer · setup · test
│   └── jev/                 # subsistema Jev (pré-análise opcional)
├── skill/*.md        # assets markdown (copiados pelo `setup` no consumidor)
└── tests/            # suíte project-agnóstica
```

**Camadas:** `cli/` = imperativo com efeitos colaterais (`process.argv`/`exit`);
`core/` = funções/classes reutilizáveis (sem `process.argv`/`exit`, sem side-effect no import);
`skill/` = markdown embarcado; `tests/` = suíte.

## Regras críticas

- **`core/` é agnóstico ao projeto.** Nenhum id, path, nome de projeto ou regra de negócio de
  consumidor. Tudo chega por `ReviewConfig`.
- **Nunca** importe caminhos de projeto (`scripts/`, `docs/.ai`, `packages/...`) nem cite
  projetos consumidores. O pacote deve poder ser copiado para um repositório zerado.
- **Assets** (`src/skill/*.md`) são resolvidos por `core/assets.ts` (`import.meta.dir`) — nunca
  por caminho relativo ao cwd.
- A config do consumidor é carregada em **runtime** (`core/config-loader.ts`); nunca importada
  estaticamente.
- O `setup` gera uma camada **autocontida** (não importa o pacote `houndsman` — só tipos
  espelhados em `.houndsman/types.ts`). Mantenha assim: é o que permite instalação **global**
  sem dependência local no projeto.
- **Jev é opcional e falha-aberto.** Sem `TYPESAFE_API_KEY` (ou com `--no-jev`), a revisão roda
  idêntica, sem chamadas de rede. Nunca torne o Jev obrigatório.
- Comandos que produzem efeito (log/exit) ficam em `cli/`; `core/` devolve dados.

## Convenções

- `type` para definições simples; `interface` só para OOP. Use `T[]`, nunca `Array<T>`.
- Arquivos/pastas em `kebab-case`; indentação por **tab** (Biome, `lineWidth: 90`).
- Commits: Conventional Commits em **inglês** (`feat: add setup command`).
- Doc-comments curtos, em português, explicando intenção/contrato — não o óbvio.

## Publicação

- Pacote **público sem escopo** (`houndsman`) — `publishConfig.access: "public"`.
- Publica **TypeScript** (`files: ["src", ...]`); quem instala precisa do Bun.
- Release automatizado por `.github/workflows/release.yml` (push em `stable`).
  Validação de PR por `.github/workflows/ci.yml`.
- Ao mudar a **API pública/tipos**, lembre: consumidores usam um snapshot em `.houndsman/types.ts`,
  regenerado com `houndsman setup` (deletando o arquivo e rodando `setup` de novo).

## Contexto adicional

- Passo a passo de publicação e operação: `NEXT-STEPS.md`.
