# AGENTS.md — houndsman

> Documentação, comentários e revisões em **português**.
> Mensagens de commit em **inglês**.
> Código-fonte (variáveis, funções, classes) em **inglês**.
> Seja sucinto nos outputs explicativos e comentários.

## Projeto

`houndsman` é um **CLI independente** que revisa Pull Requests: classifica o diff por domínio,
despacha watchdogs especializados (um subagente por brief) e consolida um relatório.

> **Terminologia:** **houndsman** = orquestrador/treinador (CLI + motor); **watchdog** = cada
> agente especialista por domínio que audita o diff (antigo "revisor"); **review/revisão** =
> o processo; **Jev** = pré-análise opcional.

O motor é **genérico e agnóstico ao projeto** — nenhuma regra, path ou nome de consumidor vive
aqui. O consumidor fornece a configuração em `houndsman.config.ts` + `.houndsman/` (camada de
projeto **autocontida**), carregada em runtime.

- **Runtime:** Bun (obrigatório). O `bin` usa shebang `#!/usr/bin/env bun`.
- **Deps de produção:** `axios` (cliente da pré-análise Jev) e `preact` (UI do `server`).
- **Publicação:** npm público, escopo da org (`@payconductor/houndsman`).

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
| `bun run houndsman -- findings <sub>` | Triagem dos findings (`list`/`set`/`done`/`sync`/...) |
| `bun run houndsman -- server` | Sobe a UI local de triagem (Bun.serve + Preact) |
| `bun publish --dry-run` | Confere o que vai no tarball |

> Fluxo obrigatório: **`bun run ci:fix` → `bun run ci` → `bun run test`**.
> `ci` isolado costuma falhar por formatação — sempre aplique o `ci:fix` primeiro.

## Arquitetura

```
src/
├── index.ts          # API pública (defineWatchdog, defineHoundsmanConfig, tipos)
├── cli/index.ts      # ÚNICO executável (bin `houndsman`)
├── core/             # bibliotecas genéricas
│   ├── config.ts            # contrato HoundsmanConfig + defineHoundsmanConfig
│   ├── config-loader.ts     # descobre/carrega houndsman.config.* em runtime
│   ├── assets.ts            # assets embarcados (src/skill/) — usados para gerar a camada
│   ├── paths.ts             # layout fixo da camada (.houndsman/) + relFromRoot
│   ├── types.ts             # Severity, Rule, WatchdogDefinition, defineWatchdog
│   ├── watchdog-registry.ts # getWatchdog/findWatchdog/getWatchdogContext(config)
│   ├── orchestrator.ts      # prepare/finalize (+ state.json no finalize)
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── file-classifier.ts   # classificação via `classify` dos watchdogs + churn
│   ├── diff-source.ts       # diff único (patch + --numstat) p/ PRs grandes
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
│   ├── finding-anchor.ts    # âncora/fingerprint de conteúdo + reancoragem
│   ├── findings-state.ts    # estado de triagem (state.json) + store atômico
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── pr-context.ts        # contexto da PR via `gh`
│   ├── commands/            # context · review · watchdog · findings · setup · test
│   └── jev/                 # subsistema Jev (pré-análise opcional)
├── server/           # servidor local (Bun.serve) + UI Preact
│   ├── index.ts             # rotas da API + shell HTML
│   ├── artifacts.ts         # descoberta de runs + leitura segura (anti-traversal)
│   ├── client-build.ts      # bundle do cliente via Bun.build (em memória)
│   └── client/              # app Preact — index.tsx (entry) + App/RunList/Filters/FindingCard/...
├── skill/*.md        # assets markdown (copiados pelo `setup` no consumidor)
└── tests/            # suíte project-agnóstica
```

**Camadas:** `cli/` = imperativo com efeitos colaterais (`process.argv`/`exit`);
`core/` = funções/classes reutilizáveis (sem `process.argv`/`exit`, sem side-effect no import);
`server/` = servidor local (rotas + UI; `Bun.serve`);
`skill/` = markdown embarcado; `tests/` = suíte.

## Regras críticas

- **`core/` é agnóstico ao projeto.** Nenhum id, path, nome de projeto ou regra de negócio de
  consumidor. Tudo chega por `HoundsmanConfig`.
- **Nunca** importe caminhos de projeto (`scripts/`, `docs/.ai`, `packages/...`) nem cite
  projetos consumidores. O pacote deve poder ser copiado para um repositório zerado.
- **Assets** (`src/skill/*.md` e a mídia em `assets/`) são resolvidos por `core/assets.ts`
  (`import.meta.dir`) — nunca por caminho relativo ao cwd. O `server` serve a logo em
  `/assets/logo.png`.
- A config do consumidor é carregada em **runtime** (`core/config-loader.ts`); nunca importada
  estaticamente.
- O `setup` gera uma camada **autocontida** (não importa o pacote `@payconductor/houndsman` —
  só tipos espelhados em `.houndsman/core/types.ts`). Mantenha assim: é o que permite
  instalação **global** sem dependência local no projeto.
- **Jev é opcional e falha-aberto.** Sem `TYPESAFE_API_KEY` (ou com `--no-jev`), a revisão roda
  idêntica, sem chamadas de rede. Nunca torne o Jev obrigatório.
- Comandos que produzem efeito (log/exit) ficam em `cli/`; `core/` devolve dados.
- **A linha de um finding nunca é a identidade.** A identidade é o `fingerprint`
  (arquivo + regra + âncora de conteúdo) em `core/finding-anchor.ts`; a linha é cache,
  recalculada por `syncState`. Não volte a chavear por `(file, line)`.
- O estado de triagem (`state.json`) é **local** e vive na pasta da run (`.runs/<slug>/`) —
  já coberto pelo `.gitignore` gerado. O `server` só vincula em `127.0.0.1` (sem auth).

## Convenções

- `type` para definições simples; `interface` só para OOP. Use `T[]`, nunca `Array<T>`.
- Arquivos/pastas em `kebab-case`; indentação por **tab** (Biome, `lineWidth: 90`).
- Commits: Conventional Commits em **inglês** (`feat: add setup command`).
- Doc-comments curtos, em português, explicando intenção/contrato — não o óbvio.

## Publicação

- Pacote **público** com escopo da org (`@payconductor/houndsman`) — `publishConfig.access: "public"`.
- Publica **TypeScript** (`files: ["src", "assets"]`); quem instala precisa do Bun.
- **Publish manual** (com 2FA), a partir da `main` — sem release automático no CI. Validação de
  PR por `.github/workflows/ci.yml`.
- Ao mudar a **API pública/tipos**, lembre: consumidores usam um snapshot em
  `.houndsman/core/types.ts`, sincronizado com `houndsman update`.

## Contexto adicional

- Vocabulário do projeto — o que é brief, findings, manifest, budget, churn, candidato, Jev
  e outros termos com sentido de domínio: `docs/GLOSSARY.md`.
