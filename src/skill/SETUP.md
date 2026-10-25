# Setup — usar o houndsman no seu projeto

O **houndsman** é um CLI instalado **globalmente**. A camada de configuração que ele gera
no seu projeto é **autocontida** — não exige nenhuma dependência local do pacote.

## Pré-requisitos

- **Bun** — o CLI e o motor usam a runtime Bun (execução de TS, `Bun.spawnSync`).
- **git** — o diff usa `git diff <base>...<head> --name-status`.
- **gh** (Opcional) — Obtém contexto da PR e dispara comentários para o GitHub
- **`HOUNDSMAN_TYPE_SAFE_API_KEY`** (opcional) — pré-análise Jev.
- **`HOUNDSMAN_DEEP_SEEK_API_KEY`** (opcional) — features de IA (briefs, contexto, classificação, resumo técnico).
- **`HOUNDSMAN_OPENAI_API_KEY`** / **`HOUNDSMAN_ANTHROPIC_API_KEY`** (opcional) — apenas se
  `ai.provider` for `openai`/`anthropic`.

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

## Harness local (opcional) — `houndsman hunt`

Quem não quer rodar a skill dentro de um agente externo pode executar a revisão 100% pelo
CLI. O maki é instalado sob demanda, fora do projeto, e reaproveita a credencial já existente:

```bash
houndsman hunt install      # baixa o maki fixado (sha256) em <HOUNDSMAN_HOME>/tools/maki
houndsman hunt doctor       # binário, modelo e credencial (opcional; não falha sem maki)
houndsman hunt --pr 456     # prepare → maki (um processo por brief) → finalize
```

- A skill `/houndsman hunt` continua sendo o caminho canônico e não depende do maki.
- `HOUNDSMAN_MAKI_PATH` aponta um binário já instalado; `HOUNDSMAN_MAKI_VERSION` troca a
  versão baixada.
- Config opcional em `houndsman.config.ts`: `hunt: { model?, concurrency?, timeoutMs?,
  retries?, binaryPath?, enabled? }`.
- Se algum watchdog falhar, o comando **não finaliza** (preserva o staging); use
  `--allow-partial` para finalizar com findings vazios registrados em `skipped`.

## Contrato do motor (`HoundsmanConfig`)

Definido em `src/core/config.ts` (pacote) e espelhado em `.houndsman/core/types.ts` (gerado):

| Campo | Descrição |
|---|---|
| `projectName` | Nome legível (prompts/docs). |
| `storage` | **Opcional** — `{ provider: "sqlite" \| "file", path? }`. Default: SQLite em `<HOUNDSMAN_HOME>/houndsman.db`. |
| `watchdogs` | Definições dos watchdogs (incluem `classify`); os **ids são derivados** das chaves. |
| `exclusions` | Arquivos que nunca entram na revisão. |
| `docMappings` | Path → documentação de contexto. |
| `priorities` | **Opcional** — prioridade por caminho `[{ pattern: RegExp, bonus: number }]`. O `bonus` soma ao churn ("linhas equivalentes"); a primeira regra que casar vence. Ordena o orçamento, o rateio do diff e o recorte do `general`. Sem config: churn puro. |
| `alwaysIncludeDocs` | Docs sempre presentes nos briefs (default `["AGENTS.md"]`). |
| `budgets` | **Opcional** — teto de arquivos por brief (`maxFilesPerBrief`, default `40`); o excedente vira "fora do orçamento" (registrar em `skipped`). |
| `concurrency` | **Opcional** — chamadas Jev simultâneas (`jev`, default `5`). |
| `ast` | **Opcional** — AST determinístico para TS/JS (`enabled`, `maxFileBytes`, `maxImpactFiles`, `languages`, `aliases`). Default: ligado; falhas são fail-open. |
| `hunt` | **Opcional** — harness local (`model`, `concurrency`, `timeoutMs`, `retries`, `binaryPath`, `enabled`). Só afeta `houndsman hunt`; a skill não depende. |

> O motor **não contém** ids, paths ou regras do projeto — tudo chega por `HoundsmanConfig`,
> carregado em runtime a partir de `houndsman.config.ts` (ou `--config <path>`).

## Estrutura do pacote (motor)

```
houndsman/
├── package.json
└── src/
    ├── index.ts              # API pública (defineWatchdog, defineHoundsmanConfig, tipos)
    ├── cli/index.ts          # CLI único — bin `houndsman`
    ├── core/                 # bibliotecas genéricas (config, orchestrator, brief, jev/, hunt/, …)
    ├── skill/*.md            # assets markdown (embarcados no pacote)
    └── tests/                # suíte da lib (project-agnóstica, "project fake")
```

## Desenvolvimento da lib

- Scripts: `bun run test`, `bun run typecheck`, `bun run ci`.
- O motor é 100% agnóstico ao consumidor: nenhuma regra, path ou nome de projeto vive aqui.
