# AGENTS.md — houndsman

> Documentação, comentários e revisões em **português**.
> Mensagens de commit em **inglês**.
> Código-fonte (variáveis, funções, classes) em **inglês**.
> Seja sucinto nos outputs explicativos e comentários.

## Projeto

`houndsman` é um **CLI independente** que revisa Pull Requests: classifica o diff por domínio,
despacha watchdogs especializados (um subagente por brief) e consolida um relatório.

> **Terminologia:** **houndsman** = orquestrador/treinador (CLI + motor); **watchdog** = cada
> agente especialista por domínio que audita o diff; **review/revisão** =
> o processo; **Jev** = pré-análise opcional.

O motor é **genérico e agnóstico ao projeto** — nenhuma regra, path ou nome de consumidor vive
aqui. O consumidor fornece a configuração em `houndsman.config.ts` + `.houndsman/` (camada de
projeto **autocontida**), carregada em runtime.

- **Runtime:** Bun (obrigatório). O `bin` usa shebang `#!/usr/bin/env bun`.
- **Deps de produção:** `axios` (cliente da pré-análise Jev) e `preact` (UI do `server`).
- **Persistência:** SQLite global via `bun:sqlite` (sem lib extra) em `<HOUNDSMAN_HOME>`;
  backend de arquivos disponível por config. Nada de execução vive no projeto.
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
| `bun run grammars:sync` | (dev) atualiza `assets/grammars/`; o `houndsman update` copia para a camada |
| `bun run houndsman -- <args>` | Executa o CLI localmente |
| `bun run houndsman -- findings <sub>` | Triagem/correção dos findings (`list`/`set`/`done`/`sync`/`batch`/`verify`/...) |
| `bun run houndsman -- compare --list` | Lista runs/variantes da branch (A/B) |
| `bun run houndsman -- compare --a <x> --b <y>` | Compara duas variantes da mesma branch |
| `bun run houndsman -- hunt [--pr <n>]` | Harness local: prepare → watchdogs via maki → finalize (opcional) |
| `bun run houndsman -- hunt install` | Baixa o maki fixado para `<HOUNDSMAN_HOME>/tools/maki` |
| `bun run houndsman -- status ping` | Renova o heartbeat da execução (timeout só vale com heartbeat) |
| `bun run houndsman -- --pr <n>` | Revisa a PR em um worktree dedicado (revisões paralelas) |
| `bun run houndsman -- worktree list` | Lista/cria/remove worktrees (`list`/`add`/`remove`/`prune`/`path`) |
| `bun run houndsman -- server` | Sobe a UI local de triagem (Bun.serve + Preact) |
| `bun publish --dry-run` | Confere o que vai no tarball |

> Fluxo obrigatório: **`bun run ci:fix` → `bun run ci` → `bun run test`**.
> `ci` isolado costuma falhar por formatação — sempre aplique o `ci:fix` primeiro.

## Arquitetura

```
src/
├── index.ts          # API pública (façade estável: tipos + classes + adaptadores)
├── cli/              # ÚNICO executável (bin `houndsman`)
│   ├── index.ts             # bootstrap fino (registry de comandos + engine lazy)
│   ├── arg-parser.ts        # reexport de core/arg-parser
│   ├── help.ts              # texto de ajuda
│   └── commands/            # Command + CommandRegistry + 1 classe por comando
├── core/             # bibliotecas genéricas
│   ├── ai/                  # camada genérica de IA (modelo, uso, schemas, features)
│   ├── engine/              # HoundsmanEngine (composition root), ReviewSession,
│   │                        # ReviewScopeResolver, review-workspace, carry-over
│   ├── ast/                 # AST determinístico: parser wasm, símbolos, delta e impacto
│   ├── domain/              # Watchdog, Classification, Diff, budget (regras puras)
│   ├── services/            # GitRepository, GhClient, FileClassifier, Verifier,
│   │                        # FixBatchBuilder, ProjectFiles, Clock,
│   │                        # WorktreeManager, PrResolver
│   ├── renderers/           # BriefRenderer, ReportRenderer, ManifestWriter
│   ├── compare.ts           # comparação A/B entre duas runs (funções puras), presenters
│   ├── config.ts            # contrato HoundsmanConfig + defineHoundsmanConfig
│   ├── business-summary.ts  # intenção da PR (fluxos/invariantes/contratos)
│   ├── builtins.ts          # watchdogs embutidos (general) + merge do consumidor
│   ├── config-loader.ts     # descobre/carrega houndsman.config.* em runtime
│   ├── project-config.ts    # defaults resolvidos + WatchdogRegistry
│   ├── defaults.ts          # constantes default do motor
│   ├── assets.ts            # assets embarcados (src/skill/) — usados para gerar a camada
│   ├── paths.ts             # layout fixo da camada (.houndsman/) + relFromRoot
│   ├── run-layout.ts        # caminhos de uma run (branch-slug)
│   ├── types.ts             # Severity, Rule, WatchdogDefinition, defineWatchdog
│   ├── watchdog-registry.ts # WatchdogRegistry (classes) + adaptadores
│   ├── orchestrator.ts      # prepare/finalize (delegam ao engine/renderers)
│   ├── arg-parser.ts        # ArgParser compartilhado (core + cli)
│   ├── concurrency.ts       # mapPool (paralelismo limitado; prepare + hunt)
│   ├── prepare-report.ts    # durações por etapa do prepare (`prepare-report.json`)
│   ├── finding-anchor.ts    # âncora/fingerprint de conteúdo + reancoragem
│   ├── findings-state.ts    # Finding/FindingsState + funções puras de triagem
│   ├── storage/             # StorageProvider (SQLite default + file) + staging por review
│   ├── hunt/                # harness local opcional (maki): install, runner e relatório
│   ├── report-builder.ts    # dedupe/render do relatório (funções puras)
│   ├── technical-summary.ts # pontos técnicos estruturais do resumo final
│   ├── brief.ts             # defaultRenderBrief + PROCEDURE (funções puras)
│   ├── verify.ts            # verificação de findings (tier local + Jev)
│   ├── fix-batch.ts         # agrupamento/paginação do lote (puro)
│   ├── file-classifier.ts   # classificação via `classify` + churn (puro)
│   ├── changed-scope.ts     # escopo do diff (símbolos alterados + fallback hunks)
│   ├── diff-source.ts       # diff único (patch + --numstat) p/ PRs grandes
│   ├── git-revision.ts      # refs/ancestralidade + arquivo por commit + diff
│   ├── git-runner.ts        # único wrapper de `Bun.spawnSync(["git", ...])`
│   ├── doc-discoverer.ts    # descoberta de docs (DocDiscoverer)
│   ├── registry-check.ts    # validações anti-drift (config-driven)
│   ├── pr-context.ts        # contexto da PR via `gh`
│   ├── commands/            # context · review · watchdog · findings · setup · update · test · scaffold
│   └── jev/                 # subsistema Jev (pré-análise opcional)
├── server/           # servidor local (Bun.serve) + UI Preact
│   ├── index.ts             # HoundsmanServer (rotas + shell)
│   ├── styles.css           # CSS da UI (servido em /assets/styles.css)
│   ├── run-repository.ts    # leitura/escrita das runs + findings + submit + comentários
│   ├── pr-inbox.ts          # PRs abertas via gh + checkout com árvore limpa
│   ├── pr-comments.ts       # threads/comentários da PR (cache de 60s)
│   ├── editor.ts            # detecção do editor (links vscode:// / jetbrains://)
│   ├── artifacts.ts         # descoberta de runs + leitura segura (anti-traversal)
│   ├── client-build.ts      # bundle do cliente via Bun.build (em memória)
│   └── client/              # app Preact — index.tsx (entry) + App/Sidebar/...
├── skill/*.md        # assets markdown (copiados pelo `setup` no consumidor)
└── tests/            # suíte project-agnóstica
```

**Camadas:** `cli/` = bootstrap + `Command` objects (log/exit); `core/` = engine/domínio/
serviços/renderers (sem `process.argv`/`exit`, sem log; devolve dados); `server/` = servidor
local; `skill/` = markdown embarcado; `tests/` = suíte.

> **Dependência:** `cli → core`. `core/` não importa `cli/` nem `server/`.

> **OO:** o motor tem um composition root (`HoundsmanEngine`) que injeta `ProjectConfig`,
> `GitRepository`, `FileClassifier`, `Verifier`, `FixBatchBuilder`. Domínio (`Watchdog`,
> `Classification`, `Diff`, `Finding`/`FindingsState`) expõe comportamento; algoritmos puros
> (âncora, churn, dedupe, parsers) continuam funções reutilizadas pelas classes.

## Regras críticas

- **`core/` é agnóstico ao projeto.** Nenhum id, path, nome de projeto ou regra de negócio de
  consumidor. Tudo chega por `HoundsmanConfig`.
- **AST é fail-open.** `core/ast/` nunca bloqueia a revisão: grammar ausente, ABI incompatível,
  arquivo grande/binário ou erro de git viram ausência de fatos. O regex continua sendo o
  fallback e `unclassified` continua existindo. As grammars wasm vivem em `assets/grammars/` e
  são resolvidas por `import.meta.dir` (`core/assets.ts`), nunca pelo cwd. O `setup`/`update`
  copiam os wasm para `.houndsman/core/grammars/`; o consumidor **não** roda sync manual.
- **Escopo do diff é obrigatório.** O `prepare` calcula `changedScope` por arquivo — o menor
  símbolo folha do AST que contém cada âncora do `git diff -U0` + âncoras soltas; sem AST,
  caem para os hunks — e o injeta no brief e na pré-análise. Finding
  com `line` fora das faixas é código pré-existente, não escopo da revisão. Nunca volte a
  mandar o watchdog "ler o arquivo inteiro".
- **Revisão de lógica é obrigatória.** O `prepare` injeta o watchdog reservado `general` em
  **todo** ciclo, com todos os arquivos alterados; não há flag de desligar (`--no-ai` não o
  remove). Ele audita fluxo/capacidade/credencial/estado e emite `Lógica:`/`Domínio:`.
- **Intenção antes dos briefs.** O `prepare` sempre grava `business-summary.json` +
  `business-brief.md`. Com IA, a versão é `source: "ai"`; sem chave, o subagente (skill) ou o
  pré-passe maki (`houndsman hunt`) grava `source: "reviewer"`; o determinístico é o fallback.
- **Composition root:** `HoundsmanEngine` injeta a config e os colaboradores (`GitRepository`,
  `FileClassifier`, `Verifier`, `FixBatchBuilder`). Pipelines não instanciam dependências
  diretamente; a CLI só conhece `Command`/`CommandRegistry`.
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
- **Jev é opcional e falha-aberto.** Sem `HOUNDSMAN_TYPE_SAFE_API_KEY` (ou com `--no-jev`), a revisão roda
  idêntica, sem chamadas de rede. Nunca torne o Jev obrigatório.
- **O harness local (`hunt`) é opcional e não substitui a skill.** A skill `/houndsman hunt`
  continua canônica para agentes externos; `houndsman hunt` é o caminho CLI via maki. Ambos
  usam o mesmo `prepare`/`finalize` e o mesmo schema de findings. Nada em `setup`/`update`
  pode passar a exigir o maki.
- **IA do fluxo normal é opcional e falha-aberto.** Sem `HOUNDSMAN_DEEP_SEEK_API_KEY`
  (ou com `--no-ai`), briefs/contexto/classificação/verify seguem sem rede.
- **`fallback: true` é último recurso.** Um watchdog fallback só assume arquivos que
  nenhum outro casou; `classify` é ignorado e múltiplos fallbacks geram warning.
- **Findings emergentes:** o `general` sempre pode emitir. Nos demais watchdogs continuam
  opt-in (`allowEmergentFindings: true`). Fora de regra, `blocking` só é aceito com
  `scenario` + `evidence`; sem os dois o motor rebaixa para `attention`.
- **Env é fonte única e prefixado.** Chaves de integração usam `HOUNDSMAN_`
  (`HOUNDSMAN_DEEP_SEEK_API_KEY`, `HOUNDSMAN_OPENAI_API_KEY`,
  `HOUNDSMAN_ANTHROPIC_API_KEY`, `HOUNDSMAN_TYPE_SAFE_API_KEY`, `HOUNDSMAN_HOME`).
  Só variáveis nativas do SO/CI (`LOCALAPPDATA`, `XDG_DATA_HOME`, `NO_COLOR`, `TERM`, `CI`)
  mantêm o nome global. Mesmo ambiente em `src/core/env.ts`.
- Comandos que produzem efeito (log/exit) ficam em `cli/`; `core/` devolve dados.
- **Saída visual centralizada.** `core/logging` expõe a classe `Logger` e a instância
  `logger` (chalk/ora), usada por `cli/` e `server/`. Módulos de negócio do
  `core/` continuam sem log.
- **A linha de um finding nunca é a identidade.** A identidade é o `fingerprint`
  (arquivo + regra + âncora de conteúdo) em `core/finding-anchor.ts`; a linha é cache,
  recalculada por `syncState`. Não volte a chavear por `(file, line)`.
- **Revisão nunca lê `process.cwd()` implicitamente.** A raiz operacional vem do
  `HoundsmanEngine` (`root` = worktree ou clone principal) e é propagada por
  `ReviewContext`/`ReviewSession`. Módulos de negócio usam `ctx.root` e `ctx.git`.
- **Worktrees são detached e vivem dentro do workspace por default:**
  `<repo>/.houndsman/worktrees/<repoSlug>/<branchSlug>` (config
  `worktrees.location: "home"` move para `<HOUNDSMAN_HOME>/worktrees`). O diretório se
  auto-ignora no git. Ficar dentro do workspace evita prompts de permissão de agentes
  de codificação (leitura/execução fora da pasta aberta). O staging da review
  (`briefs/`, `findings/`, contexto) acompanha: fica em
  `<worktree>/.houndsman/work/<reviewIdé `(repoKey, branch, variant)` — `variant`
  ausente é a run principal; rótulos A/B (`--variant <label>`) criam runs separadas
  para a mesma branch sem apagar a anterior.<n>` resolve via
  `gh`, busca `refs/pull/<n>/head` e cria/reusa o worktree; `--worktree <path>` usa um
  já existente. A identidade da review continua `(repoKey, branch)`; `worktreePath` e
  `prNumber` são metadados persistentes. Remoção é manual (`worktree remove|prune`).
  Os segmentos `<repoSlug>/<branchSlug>` são `<trecho legível truncado>-<hash8>`:
  o hash garante unicidade e o truncamento evita `Filename too long` (MAX_PATH 260)
  no checkout de PRs com paths profundos. Não volte a usar o nome bruto.
  Ao criar/reusar um worktree, a camada gerada (`.houndsman/core`) é espelhada
  do clone principal: o checkout só traz arquivos versionados e, sem ela, a
  config não carrega (`watchdogs` importam `../core/types`). O CLI também
  auto-repara a camada ao rodar **dentro** de um worktree.
- A persistência é **centralizada** em `core/storage/`. Nenhum módulo grava runs/findings/
  artefatos em disco por conta própria: use o `StorageProvider` (SQLite default; `file` é o
  fallback). O diretório global é `<HOUNDSMAN_HOME>` (OS data dir ou env override).
- O staging dos subagentes (`briefs/`, `findings/`, contexto) vive em
  `<HOUNDSMAN_HOME>/work/<reviewId>/` e é limpo após o `--finalize`. O `server` só vincula em
  `127.0.0.1` (sem auth) e roda `PRAGMA optimize` + `VACUUM` no start (fail-open).
- O **commit revisado** é a base do incremental e do verify: `reviewedSha` (review) e
  `foundAtSha` (por finding). O prepare incremental revisa só `reviewedSha..HEAD` e carrega o
  resto; o `findings verify` compara contra esse commit fixado — nunca contra um `HEAD`
  arbitrário.
- Assinatura de findings: PK UUID no banco, `short_id` (10 hex) como identidade de exibição.
  Comandos que aceitam id resolvem prefixo único; a linha nunca é identidade.

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
