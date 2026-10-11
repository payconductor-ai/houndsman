# houndsman — skill

Revisão automatizada de Pull Requests — CLI independente + camada de configuração do projeto.

## Quem executa o quê

- **Você** só invoca o skill: `/houndsman`. Não roda script à mão.
- **O skill** orquestra: executa o CLI `bun run houndsman` e despacha os subagentes.
- **O CLI** tem passos distintos — um comando cada:

| Passo | Comando | Quem roda | Resultado |
|---|---|---|---|
| 0. Contexto | `bun run houndsman context` | subagente | `context.json` + `context-brief.md` → `context-summary.json` |
| 1. Preparar | `bun run houndsman` | skill | `classification.json` + `candidates.json` + `briefs/` + `manifest.json` |
| 2. Revisar | *(subagentes)* | skill | `findings/<revisor>.json` (um por revisor) |
| 3. Finalizar | `bun run houndsman --finalize` | skill | `review.md` |

## Comandos

| Comando | Função |
|---|---|
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman` | Passo 1 — preparar (gera os briefs) |
| `houndsman --finalize` | Passo 3 — gerar o relatório |
| `houndsman reviewer <id>` | Contexto de um revisor (`--json`, `--rules`) |
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman doctor` | Valida a configuração e o ambiente (anti-drift) |
| `houndsman test` | Roda a suíte de testes da lib |

### Flags

`--config <path>` · `--base <branch>` (default `main`) · `--head <ref>` (default `HEAD`) ·
`--branch <nome>` · `--dir <dir>` · `--clean` · `--no-jev` · `--fail-on-blocking` (no `--finalize`).

## Artefatos

Tudo em `.houndsman/.runs/<branch-slug>/` (default do `artifactDir`, `.houndsman/.runs`):

| Arquivo | Conteúdo |
|---|---|
| `classification.json` | Revisores ativados + status (A/M/D/R) |
| `candidates.json` | Candidatos da pré-análise Jev |
| `context.json` | Payload bruto da PR via `gh` (ou marcador de indisponível) |
| `context-summary.json` | Resumo do subagente (objetivo/motivação/alterações) |
| `briefs/<reviewer>.md` | Instruções prontas para cada sub-agente |
| `manifest.json` | Resumo (revisores, arquivos, deletados, status, contexto) |
| `findings/<reviewer>.json` | Saída dos sub-agentes (schema `OUTPUT-FORMAT.md`) |
| `review.md` | Relatório final |

## Estrutura

### Pacote (motor)

```
src/
├── index.ts             # API pública (defineReviewer, defineReviewConfig, tipos)
├── cli/index.ts         # CLI ÚNICO (bin `houndsman`)
├── core/                # bibliotecas genéricas
│   ├── config.ts            # ReviewConfig + defineReviewConfig + resolveOutputFormatPath
│   ├── config-loader.ts     # descoberta/carregamento de houndsman.config.ts
│   ├── assets.ts            # resolução de assets embarcados (src/skill/)
│   ├── types.ts             # Severity, Rule, ReviewerDefinition, defineReviewer
│   ├── reviewer-registry.ts # getReviewer/findReviewer/getReviewerContext(config)
│   ├── orchestrator.ts      # preparar/finalizar
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── pr-context.ts        # contexto da PR via gh
│   ├── file-classifier.ts   # classificação (via `classify` dos revisores)
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── commands/            # context · review · reviewer · setup · test
│   └── jev/                 # subsistema Jev (Passo 1.5)
├── skill/*.md           # assets markdown (embarcados no pacote)
└── tests/               # suíte da lib (project-agnóstica, "project fake")
```

### Projeto (consumidor — gerado por `houndsman setup`)

```
houndsman.config.ts      # ReviewConfig (dados; descoberto em runtime)
houndsman/
├── types.ts             # snapshot dos tipos + helpers (autocontido)
├── reviewers/           # 1 módulo .ts por revisor (regras + classify)
│   └── index.ts         # REVIEWER_DEFINITIONS + type ReviewerId
├── exclusions.ts
├── doc-mappings.ts
└── skill/*.md           # cópia local dos docs
```

> Os `SKILL.md` em `.agents/skills/houndsman/` e `.claude/skills/houndsman/` são
> ponteiros para `.houndsman/skill/houndsman.md`.

## Manutenção

> As regras devem refletir os padrões **aplicados hoje**. Antes de adicionar uma regra,
> prove que o padrão existe no código; regras não aplicadas geram falsos positivos.

1. Novas regras/revisores → editar `.houndsman/reviewers/<id>.ts` (regras + escopo +
   `classify`) ou `doc-mappings.ts`/`exclusions.ts`. Um revisor novo exige só o módulo em
   `.houndsman/reviewers/<id>.ts` + entrada em `.houndsman/reviewers/index.ts`.
2. Rodar `bun run houndsman doctor` — valida a config (definições, classificação, specs Jev).

> Para qualquer alteração de regra (pontual ou auditoria completa), use o skill
> **`update-houndsman`**: `.houndsman/skill/update-houndsman.md`.
