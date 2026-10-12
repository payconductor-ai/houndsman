# Desenvolvendo o houndsman

> Guia para **contribuir e evoluir o motor**. Se você só quer **usar** a lib no dia a dia,
> comece pelo [`README.md`](../README.md).

O `houndsman` é um **CLI independente**. O **motor** (este pacote) é genérico e agnóstico ao
projeto; as regras vivem na camada de cada consumidor (`houndsman.config.ts` + `.houndsman/`),
carregada em runtime.

---

## Missão e princípios

Toda contribuição deve preservar os princípios abaixo. Mudança que viola qualquer um deles
está **fora da missão** — mesmo que pareça uma boa ideia.

1. **Motor agnóstico.** `core/` não contém id, path, nome de projeto nem regra de negócio de
   consumidor. Tudo chega por `HoundsmanConfig`.
2. **Camada autocontida.** O que o `setup` gera no projeto **não importa** o pacote
   `houndsman` em runtime — é o que permite instalação **global** sem dependência local.
3. **Separação de camadas.** `cli/` = imperativo com efeitos (`process.argv`/`exit`);
   `core/` = funções/classes reutilizáveis (sem efeito no import); `skill/` = markdown
   embarcado; `tests/` = suíte.
4. **Jev opcional e falha-aberto.** Sem `TYPESAFE_API_KEY` (ou com `--no-jev`), a revisão roda
   idêntica, sem chamadas de rede. **Nunca** torne o Jev obrigatório.
5. **Assets por `import.meta.dir`.** `src/skill/*.md` são resolvidos por `core/assets.ts` —
   nunca por caminho relativo ao cwd.
6. **Config em runtime.** `houndsman.config.ts` é carregada por `core/config-loader.ts` —
   nunca importada estaticamente.

> Nunca importe caminhos de projetos consumidores (`scripts/`, `docs/...`, `packages/...`) nem
> cite projetos específicos. O pacote deve poder ser copiado para um repositório zerado.

---

## Arquitetura

```
src/
├── index.ts          # API pública (defineWatchdog, defineHoundsmanConfig, tipos)
├── cli/index.ts      # ÚNICO executável (bin `houndsman`)
├── core/             # bibliotecas genéricas
│   ├── config.ts            # contrato HoundsmanConfig + defineHoundsmanConfig
│   ├── config-loader.ts     # descobre/carrega houndsman.config.* em runtime
│   ├── assets.ts            # assets embarcados (src/skill/) — geram a camada
│   ├── paths.ts             # layout fixo da camada (.houndsman/) + relFromRoot
│   ├── types.ts             # Severity, Rule, WatchdogDefinition, defineWatchdog
│   ├── watchdog-registry.ts # getWatchdog/findWatchdog/getWatchdogContext
│   ├── orchestrator.ts      # prepare/finalize
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE
│   ├── file-classifier.ts   # classificação via `classify` dos watchdogs + churn
│   ├── diff-source.ts       # diff único (patch + --numstat) p/ PRs grandes
│   ├── doc-discoverer.ts    # descoberta de docs
│   ├── report-builder.ts    # dedupe/render do relatório
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── pr-context.ts        # contexto da PR via `gh`
│   ├── commands/            # context · review · watchdog · setup · update · test
│   └── jev/                 # subsistema Jev (pré-análise opcional)
├── skill/*.md        # assets markdown (copiados pelo `setup`)
└── tests/            # suíte project-agnóstica
```

O nome vem do *houndsman* (treinador de cães de caça): escolhe cada cão pelo faro, manda o
mais adequado para cada terreno e recolhe tudo o que a matilha encontrou. Aqui, o motor
coordena a caçada; os **watchdogs** são o time.

---

## Fluxos internos

### Review (Passo 0 → 3)

```
houndsman context   ─► context.json ─► subagente ─► context-summary.json
      ↓
[1] houndsman        ─► classification.json + candidates.json + briefs/ + manifest.json
      ↓
[2] N subagentes     ─► findings/<watchdog>.json
      ↓
[3] --finalize       ─► review.md
```

- **Passo 0** — `context` coleta a PR via `gh`. Ausente/sem login/sem PR → `available:false`
  e exit 0 (a revisão segue sem a seção de contexto).
- **Passo 1** — coleta o diff **uma única vez** (`diff-source`: `git diff` + `--numstat`),
  classifica conforme o `classify` de cada watchdog, aplica exclusões, roda a pré-análise Jev
  (se houver chave) e gera um brief por watchdog. Cada brief é **priorizado por churn** e
  limitado pelo **orçamento** (`budgets.maxFilesPerBrief`, default 40); o excedente vira
  "fora do orçamento" e deve ser registrado em `skipped`.
- **Passo 2** — um subagente por brief (despachados em **ondas**) grava
  `findings/<watchdog>.json` (schema em `src/skill/OUTPUT-FORMAT.md`).
- **Passo 3** — valida o schema, deduplica por `(file, line, rule)`, agrupa por severidade
  **e por arquivo**, grava `review.md` + um `review.<watchdog>.md` por domínio com achados e
  anexa a tabela de cobertura. **Falha** se faltar algum `findings/<watchdog>.json`.

> Por que comandos separados? Entre o Passo 1 e o 3 acontece trabalho de LLM (os subagentes).

### Setup / update (camada do projeto)

- `setup` divide a camada em **auto-gerado** (`.houndsman/core/**`, `.houndsman/.gitignore`,
  ponteiros de skill) e **usuário** (`watchdogs/`, `exclusions.ts`, `doc-mappings.ts`,
  `houndsman.config.ts`).
- `update` reescreve **só** o auto-gerado — nunca toca nas regras do usuário.
- `doctor` (`registry-check.ts` + `cli/index.ts`) valida ids, `classify`, specs Jev, ambiente e a credencial Jev (chamada mínima).

Detalhe: `src/skill/*.md` são copiados para `.houndsman/core/skill/` com `{{projectName}}`
resolvido no momento da geração.

---

## Desenvolvimento

```bash
bun run test      # suíte da lib (project-agnóstica, usa src/tests/fixtures/fake-project.ts)
bun run ci        # biome ci . + tsc -b
bun run ci:fix    # corrige lint/format/imports — RODE ANTES do `ci`
bun run typecheck # tsc -b
bun run lint      # biome check .
bun run format    # biome format --write .
bun run build     # bun build → dist/ (bundle único)
bun run houndsman -- <args>   # executa o CLI localmente
bun publish --dry-run         # confere o tarball
```

> **Fluxo obrigatório:** `bun run ci:fix` → `bun run ci` → `bun run test`.
> `ci` isolado costuma falhar por formatação — sempre aplique o `ci:fix` primeiro.

### Ao melhorar / estender

- **Comportamento do motor mudou?** Atualize a suíte (`src/tests`) — ela é project-agnóstica
  ("project fake").
- **Mudou a API pública/tipos?** Consumidores usam um **snapshot** em
  `.houndsman/core/types.ts`, regenerado com `houndsman update` (ou deletando `.houndsman/core/`
  e rodando `setup`).
- **Mudou o markdown do skill?** É **asset** — `houndsman update` propaga para os consumidores.
- **Nova flag/comando?** Documente no `HELP` do `cli/index.ts` **e** nos `src/skill/*.md`.

### Verificação antes de fechar um PR

```bash
bun run houndsman doctor   # config sem drift + ambiente
bun run houndsman test     # suíte da lib
bun run ci:fix && bun run ci
```

---

## Vocabulário

Vários termos do domínio têm aqui um sentido **específico** (não o usual da indústria):
*brief*, *manifest*, *budget*, *overflow*, *findings*, *candidate*, *churn*.

A tabela completa — com o significado e onde cada termo vive — está em
[`GLOSSARY.md`](./GLOSSARY.md). Consulte antes de nomear código, variáveis de config ou
seções de relatório; se um conceito for renomeado, atualize **código + `AGENTS.md` +
`GLOSSARY.md`** no mesmo PR.

---

## Convenções de código

- `type` para definições simples; `interface` só para OOP. Use `T[]`, nunca `Array<T>`.
- Arquivos/pastas em `kebab-case`; indentação por **tab** (Biome, `lineWidth: 90`).
- Doc-comments curtos, **em português**, explicando intenção/contrato — não o óbvio.
- Código-fonte (variáveis, funções, classes) em **inglês**.
- Commits: **Conventional Commits em inglês** (`feat: add setup command`).

---

## Escrita de regras (resumo do contrato)

A rubrica completa vive no skill `src/skill/houndsman-update.md` (`/houndsman-update`). O
essencial:

- **Prefixo de polaridade obrigatório**: `Promover:` (DEVE acontecer) · `Evitar:` / `Não` /
  `Nunca` (NÃO DEVE acontecer).
- **Só regra que o projeto aplica hoje** — com evidência (`arquivo:linha` para afirmativas;
  `0 ocorrências via grep` do anti-padrão para negativas).
- **Geral e reutilizável** no domínio; sem jargão abreviado nem qualificador vago.
- O texto é renderizado **literalmente** no brief do subagente (`renderBrief`) — ambiguidade
  vira ruído.

Ver também `src/skill/AUDIT-PROTOCOL.md` (taxonomia de veredito da auditoria).

---

## Mapa da camada do consumidor

| Arquivo | Papel |
|---|---|
| `.houndsman/watchdogs/<id>.ts` | Fonte de verdade: `defineWatchdog` com `rules`, `scope`, `classify`, ... |
| `.houndsman/watchdogs/index.ts` | `WATCHDOG_DEFINITIONS` — as **chaves definem os ids** |
| `houndsman.config.ts` | `houndsmanConfig` do projeto (descoberto em runtime) |
| `.houndsman/exclusions.ts` | `EXCLUSION_PATTERNS` + `isExcluded` |
| `.houndsman/doc-mappings.ts` | `DOC_MAPPINGS` (path → docs) |
| `.houndsman/core/types.ts` | Snapshot gerado dos tipos (autocontido) |
| `src/core/brief.ts` | Render do brief: `defaultRenderBrief` + `PROCEDURE` |
| `src/core/registry-check.ts` | Validação anti-drift (config-driven) |

---

## Publicação

- Pacote **público** com escopo da org (`@payconductor/houndsman`), `publishConfig.access: "public"`.
- Publica **TypeScript** (`files: ["src", "assets", ...]`); quem instala precisa do Bun.
- **Publish manual** (com 2FA) a partir da `main` — sem release automático. Validação de PR por
  `.github/workflows/ci.yml`.
