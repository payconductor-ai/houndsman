# Setup — usar o houndsman no seu projeto

O **houndsman** é um CLI instalado **globalmente**. A camada de configuração que ele gera
no seu projeto é **autocontida** — não exige nenhuma dependência local do pacote.

## Pré-requisitos

- **Bun** — o CLI e o motor usam a runtime Bun (execução de TS, `Bun.spawnSync`).
- **git** — o diff usa `git diff <base>...<head> --name-status`.
- Opcional: **`gh`** (contexto da PR) e **`TYPESAFE_API_KEY`** (pré-análise Jev). O pipeline
  segue normalmente sem eles.

## Instalação (global)

```bash
bun add -g @payconductor/houndsman
```

O comando `houndsman` fica disponível em qualquer diretório.

## Configuração

Na raiz do seu projeto:

```bash
bun run houndsman setup
```

Isso cria:

A camada separa o que é **auto-gerado** do que é **do usuário**:

| Caminho | Dono | O que é |
|---|---|---|
| `houndsman.config.ts` | usuário | Configuração — um objeto de dados (sem imports do pacote) |
| `.houndsman/watchdogs/example.ts` + `index.ts` | usuário | Comece com **1 watchdog de exemplo** |
| `.houndsman/exclusions.ts` | usuário | Arquivos que nunca entram na revisão |
| `.houndsman/doc-mappings.ts` | usuário | path → documentação de contexto |
| `.houndsman/core/types.ts` | **auto** | Snapshot dos tipos + helpers (tipagem sem install) |
| `.houndsman/core/skill/*.md` | **auto** | Documentação do skill |
| `.houndsman/.gitignore` | **auto** | Ignora `core/` (gerado) |
| `.agents/skills/houndsman/SKILL.md` etc. | **auto** | `SKILL.md` do skill `/houndsman` (capabilities `hunt`/`train`/`fix`) por harness |

Além disso, adiciona o script `"houndsman": "houndsman"` ao `package.json` — assim
`bun run houndsman [...]` funciona na raiz do projeto. Runs, findings e artefatos ficam no
storage global (`<HOUNDSMAN_HOME>/houndsman.db`) — fora do projeto.

Flags: `--name <projeto>` · `--harness agents,claude|both|none` · `--force` (sobrescreve só os
arquivos do usuário). É **idempotente** — arquivos do usuário existentes são mantidos.

## Atualizar (auto-gerados)

Depois de atualizar a lib, sincronize os arquivos auto-gerados **sem tocar** nas suas regras:

```bash
bun run houndsman update      # reescreve .houndsman/core/** e .houndsman/.gitignore
```

## Verificar

```bash
bun run houndsman doctor         # valida config + ambiente + credencial Jev
bun run houndsman --base main    # prepara briefs do diff atual
```

## Capabilities do skill

Depois do setup, invoque o skill `/houndsman` no seu harness:

| Capability | Para quê |
|---|---|
| `/houndsman hunt` | Revisar a PR (default: `/houndsman`). |
| `/houndsman train` | Adicionar/ajustar/remover regras dos watchdogs. |
| `/houndsman fix` | Corrigir os findings marcados como `execute`. |

## Contrato do motor (`HoundsmanConfig`)

Definido em `src/core/config.ts` (pacote) e espelhado em `.houndsman/core/types.ts` (gerado):

| Campo | Descrição |
|---|---|
| `projectName` | Nome legível (prompts/docs). |
| `storage` | **Opcional** — `{ provider: "sqlite" \| "file", path? }`. Default: SQLite em `<HOUNDSMAN_HOME>/houndsman.db`. |
| `watchdogs` | Definições dos watchdogs (incluem `classify`); os **ids são derivados** das chaves. |
| `exclusions` | Arquivos que nunca entram na revisão. |
| `docMappings` | Path → documentação de contexto. |
| `alwaysIncludeDocs` | Docs sempre presentes nos briefs (default `["AGENTS.md"]`). |
| `budgets` | **Opcional** — teto de arquivos por brief (`maxFilesPerBrief`, default `40`); o excedente vira "fora do orçamento" (registrar em `skipped`). |
| `concurrency` | **Opcional** — chamadas Jev simultâneas (`jev`, default `5`). |

> O motor **não contém** ids, paths ou regras do projeto — tudo chega por `HoundsmanConfig`,
> carregado em runtime a partir de `houndsman.config.ts` (ou `--config <path>`).

## Estrutura do pacote (motor)

```
houndsman/
├── package.json
└── src/
    ├── index.ts              # API pública (defineWatchdog, defineHoundsmanConfig, tipos)
    ├── cli/index.ts          # CLI único — bin `houndsman`
    ├── core/                 # bibliotecas genéricas (config, orchestrator, brief, jev/, …)
    ├── skill/*.md            # assets markdown (embarcados no pacote)
    └── tests/                # suíte da lib (project-agnóstica, "project fake")
```

## Desenvolvimento da lib

- Scripts: `bun run test`, `bun run typecheck`, `bun run ci`.
- O motor é 100% agnóstico ao consumidor: nenhuma regra, path ou nome de projeto vive aqui.
