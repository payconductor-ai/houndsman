# houndsman — skill

Revisão automatizada de Pull Requests — CLI independente + camada de configuração do projeto.

## Capabilities

Um único skill (`/houndsman`), quatro capabilities (detalhadas em `hunt.md`, `train.md`,
`fix.md`, `verify.md`):

| Capability | O que faz |
|---|---|
| `hunt` | Revisão de PR (Passos 0–3; incremental quando possível). |
| `train` | Manutenção das regras dos watchdogs. |
| `fix` | Correção dos findings marcados como `execute`. |
| `verify` | Confere se as violações foram resolvidas, sem re-revisar a PR. |

## Dois caminhos para o `hunt`

| Caminho | Quem usa | Requisitos |
|---|---|---|
| Skill `/houndsman hunt` | agente externo (Copilot/Claude/etc.) | nenhum |
| CLI `houndsman hunt` | operador/CI, sem agente | `houndsman hunt install` |

Os dois usam o mesmo `prepare`/`finalize`, o mesmo staging e o mesmo schema de findings.
O CLI só substitui o despacho manual dos subagentes por processos maki headless.

## Terminologia

- **houndsman** — o orquestrador/treinador (CLI + motor).
- **watchdog** — cada agente especialista por domínio que audita o diff.
- **brief** — instruções prontas para um watchdog (o prompt do subagente), incluindo o
  **escopo do diff** (faixas/símbolos alterados que podem virar finding).
- **findings** — os achados que o subagente grava em JSON (único output consumido).
- **candidato (Jev)** — indício automático; **não** é achado (o watchdog confirma ou refuta).
- **churn** — linhas adicionadas/removidas por arquivo; usado para priorizar a leitura.
- **budget / orçamento** — teto de arquivos por brief; o excedente ("fora do orçamento")
  não é revisado, mas fica registrado em `skipped`.
- **review/revisão** — o processo de revisão.

## Quem executa o quê

- **Você** só invoca o skill: `/houndsman`. Não roda script à mão.
- **O skill** orquestra: executa o CLI `bun run houndsman` e despacha os subagentes.
- **O CLI** tem passos distintos — um comando cada:

| Passo | Comando | Quem roda | Resultado |
|---|---|---|---|
| 0. Contexto | `houndsman --pr` (via `gh`) | prepare | `context.json` + `context-brief.md` → `context-summary.json` (IA; sem IA, subagente) |
| 1. Preparar | `bun run houndsman` | skill | `classification.json` + `candidates.json` + `business-summary.json` + `briefs/` + `manifest.json` |
| 1.5. Intenção | *(subagente)* | skill, só sem IA | `business-summary.json` enriquecido (só quando não veio da IA) |
| 2. Revisar | *(subagentes)* | skill | `findings/<watchdog>.json` (inclui o `general`, sempre ativo) |
| 3. Finalizar | `bun run houndsman --finalize` | skill | `review-resume.md` + triagem no storage |

> **Alvo = PR** (ex.: “revise a PR 456”): use `houndsman --pr 456` e
> `houndsman --pr 456 --finalize`. O prepare coleta o contexto via `gh`, cria um **worktree**
> detached em `<repo>/.houndsman/worktrees/<repo>/<branch>` e resume o contexto com IA;
> os briefs trazem `**Worktree:**` e os subagentes devem ler essa árvore (nunca o clone
> principal). Despache os briefs em paralelo (mesmo bloco de tool calls).

## Comandos

| Comando | Função |
|---|---|
| `houndsman context` | Contexto da PR via `gh` (`--pr <n>`/`--worktree <path>`) — o prepare já coleta com `--pr` |
| `houndsman` | Passo 1 — preparar (gera os briefs) |
| `houndsman --pr <n>` | Passo 1 em worktree dedicado (revisões paralelas) |
| `houndsman --finalize` | Passo 3 — gravar a triagem e o resumo final (`--pr <n>` reusa o worktree) |
| `houndsman hunt [--pr <n>]` | Harness local opcional (maki): prepare → watchdogs → finalize |
| `houndsman compare` | Compara duas runs/variantes (`--list`, `--a`, `--b` ou dois slugs) |
| `houndsman golden` | Avalia runs contra um golden set de defeitos (`recall`/`precisão`) |
| `houndsman hunt install` | Baixa o maki fixado para `<HOUNDSMAN_HOME>/tools/maki` |
| `houndsman worktree <ação>` | `list`/`add`/`remove`/`prune`/`path` dos worktrees |
| `houndsman watchdog <id>` | Contexto de um watchdog (`--json`, `--rules`) |
| `houndsman findings <sub>` | Triagem/correção dos findings (`list`/`set`/`done`/`sync`/`batch`/`verify`/...) |
| `houndsman server` | UI local de triagem (Bun.serve + Preact) |
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman update` | Sincroniza os arquivos auto-gerados (`.houndsman/core`) |
| `houndsman doctor` | Valida a configuração, o ambiente e a credencial Jev (anti-drift) |
| `houndsman test` | **Manutenção da lib** — roda a suíte de testes do pacote (não é uso do consumidor) |

### Flags

`--config <path>` · `--base <branch>` (default `main`) · `--head <ref>` (default `HEAD`) ·
`--branch <nome>` · `--pr <n>` · `--worktree <path>` · `--clean` · `--full` · `--no-jev` ·
`--fail-on-blocking` (no `--finalize`).

## Artefatos

Runs, findings e artefatos vivem no **storage global** (SQLite em `<HOUNDSMAN_HOME>/houndsman.db`):

| Item | Conteúdo |
|---|---|
| review | Repo (`origin` normalizado), branch, slug, base/head, commit revisado, status e timestamps |
| findings | Decisão/execução + fingerprint + âncora + histórico + vínculo com o GitHub |
| `classification.json` | Watchdogs ativados + status (A/M/D/R) + churn |
| `candidates.json` | Candidatos da pré-análise Jev |
| `business-summary.json` / `business-brief.md` | Modelo de intenção da PR e o brief do passo |
| `manifest.json` | Resumo (watchdogs, arquivos, deletados, contexto, intenção, orçamento, churn) |
| `briefs/<watchdog>.md` | Brief enviado a cada sub-agente (auditoria) |
| `review-resume.md` | Resumo final: negócio, pontos técnicos, cobertura por domínio e conclusão |
| `verify.md` | Relatório do `findings verify` |
| `context.json` / `context-brief.md` / `context-summary.json` | Contexto da PR |

O **staging dos subagentes** fica em `<HOUNDSMAN_HOME>/work/<reviewId>/` e é limpo após o
`--finalize`. Briefs e contexto também são persistidos como artefatos (acima); apenas os
findings brutos existem só no staging:

| Arquivo | Conteúdo |
|---|---|
| `briefs/<watchdog>.md` | Instruções prontas para cada sub-agente (arquivos por risco) |
| `findings/<watchdog>.json` | Saída dos sub-agentes (schema `OUTPUT-FORMAT.md`) |
| `context.json` / `context-brief.md` / `context-summary.json` | Contexto da PR |

## Estrutura

### Pacote (motor)

```
src/
├── index.ts             # API pública (defineWatchdog, defineHoundsmanConfig, tipos)
├── cli/index.ts         # CLI ÚNICO (bin `houndsman`)
├── core/                # bibliotecas genéricas
│   ├── config.ts            # contrato HoundsmanConfig + defineHoundsmanConfig
│   ├── config-loader.ts     # descoberta/carregamento de houndsman.config.ts
│   ├── assets.ts            # assets embarcados (src/skill/) — usados para gerar a camada
│   ├── paths.ts             # layout fixo da camada (.houndsman/) + relFromRoot
│   ├── types.ts             # Severity, Rule, WatchdogDefinition, defineWatchdog
│   ├── watchdog-registry.ts # getWatchdog/findWatchdog/getWatchdogContext(config)
│   ├── orchestrator.ts      # fachada: preparar/finalizar (pipelines em engine/)
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── pr-context.ts        # contexto da PR via gh
│   ├── file-classifier.ts   # classificação (via `classify` dos watchdogs) + churn
│   ├── diff-source.ts       # diff único (patch + --numstat) p/ churn/orçamento
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
│   ├── finding-anchor.ts    # âncora/fingerprint de conteúdo + reancoragem
│   ├── findings-state.ts    # estado de triagem + funções puras
│   ├── git-revision.ts      # refs/ancestralidade + arquivo por commit + diff por intervalo
│   ├── verify.ts            # verificação de findings (tier local + Jev)
│   ├── run-status.ts        # status da review (reviewing/review_done/fixing/fix_done)
│   ├── storage/            # StorageProvider (SQLite default + arquivos) + staging
│   ├── fix-batch.ts         # agrupamento/paginação do lote (findings batch)
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── commands/            # context · review · watchdog · setup · update · test
│   └── jev/                 # subsistema Jev (Passo 1.5)
├── skill/*.md           # assets markdown (embarcados no pacote)
└── tests/               # suíte da lib (project-agnóstica, "project fake")
```

### Projeto (consumidor — gerado por `houndsman setup`)

```
houndsman.config.ts           # HoundsmanConfig (dados; descoberto em runtime)
.houndsman/
├── .gitignore                # AUTO — ignora core/ (nada de execução fica no projeto)
├── core/                     # AUTO — sincronizado por `houndsman update`
│   ├── types.ts              # snapshot dos tipos + helpers (autocontido)
│   └── skill/*.md            # documentação do skill
├── watchdogs/                # USUÁRIO — 1 módulo .ts por watchdog
│   └── index.ts              # WATCHDOG_DEFINITIONS + type WatchdogId
├── exclusions.ts             # USUÁRIO
└── doc-mappings.ts           # USUÁRIO
```

> O `SKILL.md` do skill (`.agents/skills/houndsman/SKILL.md` e
> `.claude/skills/houndsman/SKILL.md`) é gerado a partir de `src/skill/SKILL.md`
> pelo `houndsman setup`/`update` (com `{{projectName}}` resolvido).

## Manutenção

> As regras devem refletir os padrões **aplicados hoje**. Antes de adicionar uma regra,
> prove que o padrão existe no código (regra negativa: prove que o anti-padrão **não** existe).
> Regras devem ser **gerais/reutilizáveis** no domínio e declarar a **polaridade** no texto
> (`Promover:` = deve acontecer; `Evitar:`/`Não`/`Nunca` = não deve acontecer).
> Cada regra vive **só** em `rules` — não a repita em `reviewFocus`/`contextFiles`/`scope`/
> `description`/`exclude` (isso só duplicaria o brief).

1. Novas regras/watchdogs → editar `.houndsman/watchdogs/<id>.ts` (regras + escopo +
   `classify`) ou `doc-mappings.ts`/`exclusions.ts`. Um watchdog novo exige só o módulo em
   `.houndsman/watchdogs/<id>.ts` + entrada em `.houndsman/watchdogs/index.ts`.
2. Rodar `bun run houndsman doctor` — valida a config (definições, classificação, specs Jev).

> Para qualquer alteração de regra (pontual ou auditoria completa), use a capability
> **`train`**: `/houndsman train` → `.houndsman/core/skill/train.md`.
