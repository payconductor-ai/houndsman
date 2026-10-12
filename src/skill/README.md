# houndsman — skill

Revisão automatizada de Pull Requests — CLI independente + camada de configuração do projeto.

## Terminologia

- **houndsman** — o orquestrador/treinador (CLI + motor).
- **watchdog** — cada agente especialista por domínio que audita o diff.
- **brief** — instruções prontas para um watchdog (o prompt do subagente).
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
| 0. Contexto | `bun run houndsman context` | subagente | `context.json` + `context-brief.md` → `context-summary.json` |
| 1. Preparar | `bun run houndsman` | skill | `classification.json` + `candidates.json` + `briefs/` + `manifest.json` |
| 2. Revisar | *(subagentes)* | skill | `findings/<watchdog>.json` (um por watchdog) |
| 3. Finalizar | `bun run houndsman --finalize` | skill | `review.md` |

## Comandos

| Comando | Função |
|---|---|
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman` | Passo 1 — preparar (gera os briefs) |
| `houndsman --finalize` | Passo 3 — gerar o relatório |
| `houndsman watchdog <id>` | Contexto de um watchdog (`--json`, `--rules`) |
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman update` | Sincroniza os arquivos auto-gerados (`.houndsman/core`) |
| `houndsman doctor` | Valida a configuração e o ambiente (anti-drift) |
| `houndsman test` | Roda a suíte de testes da lib |

### Flags

`--config <path>` · `--base <branch>` (default `main`) · `--head <ref>` (default `HEAD`) ·
`--branch <nome>` · `--dir <dir>` · `--clean` · `--no-jev` · `--fail-on-blocking` (no `--finalize`).

## Artefatos

Tudo em `.houndsman/.runs/<branch-slug>/` (default do `artifactDir`, `.houndsman/.runs`):

| Arquivo | Conteúdo |
|---|---|
| `classification.json` | Watchdogs ativados + status (A/M/D/R) + churn |
| `candidates.json` | Candidatos da pré-análise Jev |
| `context.json` | Payload bruto da PR via `gh` (ou marcador de indisponível) |
| `context-summary.json` | Resumo do subagente (objetivo/motivação/alterações) |
| `briefs/<watchdog>.md` | Instruções prontas para cada sub-agente (arquivos por risco) |
| `manifest.json` | Resumo (watchdogs, arquivos, deletados, status, contexto, orçamento, churn) |
| `findings/<watchdog>.json` | Saída dos sub-agentes (schema `OUTPUT-FORMAT.md`) |
| `review.md` | Relatório final (achados agrupados por arquivo) |
| `review.<watchdog>.md` | Relatório por domínio (só quando há achados) |

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
│   ├── orchestrator.ts      # preparar/finalizar
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── pr-context.ts        # contexto da PR via gh
│   ├── file-classifier.ts   # classificação (via `classify` dos watchdogs) + churn
│   ├── diff-source.ts       # diff único (patch + --numstat) p/ churn/orçamento
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
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
├── .gitignore                # AUTO — ignora core/ e .runs/
├── core/                     # AUTO — sincronizado por `houndsman update`
│   ├── types.ts              # snapshot dos tipos + helpers (autocontido)
│   └── skill/*.md            # documentação do skill
├── watchdogs/                # USUÁRIO — 1 módulo .ts por watchdog
│   └── index.ts              # WATCHDOG_DEFINITIONS + type WatchdogId
├── exclusions.ts             # USUÁRIO
└── doc-mappings.ts           # USUÁRIO
```

> Os `SKILL.md` em `.agents/skills/houndsman/` e `.claude/skills/houndsman/` são
> ponteiros para `.houndsman/core/skill/houndsman.md`.

## Manutenção

> As regras devem refletir os padrões **aplicados hoje**. Antes de adicionar uma regra,
> prove que o padrão existe no código (regra negativa: prove que o anti-padrão **não** existe).
> Regras devem ser **gerais/reutilizáveis** no domínio e declarar a **polaridade** no texto
> (`Promover:` = deve acontecer; `Evitar:`/`Não`/`Nunca` = não deve acontecer).

1. Novas regras/watchdogs → editar `.houndsman/watchdogs/<id>.ts` (regras + escopo +
   `classify`) ou `doc-mappings.ts`/`exclusions.ts`. Um watchdog novo exige só o módulo em
   `.houndsman/watchdogs/<id>.ts` + entrada em `.houndsman/watchdogs/index.ts`.
2. Rodar `bun run houndsman doctor` — valida a config (definições, classificação, specs Jev).

> Para qualquer alteração de regra (pontual ou auditoria completa), use o skill
> **`houndsman-update`**: `.houndsman/core/skill/houndsman-update.md`.
