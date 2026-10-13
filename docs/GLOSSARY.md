# Glossário — houndsman

> Vocabulário **de domínio** do projeto. Vários termos aqui são comuns em outras
> ferramentas, mas no houndsman têm um significado específico — *brief*, *manifest*,
> *budget*, *candidate*, *churn* não são o que parecem. Em caso de divergência, o
> **código é a fonte de verdade** (`src/`).

Leitura das tabelas: **Termo** → **o que significa aqui** → **onde vive / aparece**.

---

## 1. Atores e conceitos

| Termo | Significado no houndsman | Onde vive |
| --- | --- | --- |
| **houndsman** | O orquestrador ("treinador"): CLI + motor. Não é um watchdog nem a revisão — é quem comanda a caçada. | `src/cli/`, `src/core/` |
| **watchdog** | Um agente especialista **por domínio** de review (ex.: rotas, banco, testes). Um subagente por brief. | `.houndsman/watchdogs/<id>.ts` |
| **review / revisão** | O **processo** completo (Passos 0–3), não um arquivo. O resultado escrito é o *relatório*. | fluxo `context → prepare → findings → finalize` |
| **subagente** | Instância de LLM despachada pelo skill para executar um brief. | `runSubagent` (harness) |
| **motor (engine)** | O pacote publicado (`@payconductor/houndsman`) — genérico e agnóstico ao projeto. | `src/core/`, `src/cli/` |
| **camada do projeto** | Config + regras do consumidor, carregada em **runtime**. | `houndsman.config.ts` + `.houndsman/` |
| **camada autocontida** | Propriedade da camada gerada: **não importa** o pacote em runtime (só tipos espelhados) — permite instalação global. | `.houndsman/core/types.ts` |
| **skill** | O comando `/houndsman` — entrada única com 4 capabilities: `hunt` (revisão), `train` (regras), `fix` (correção) e `verify` (conferir resolução). | `src/skill/SKILL.md` |
| **capability** | Uma das quatro lentes do skill: `hunt` (revisar PR), `train` (manter regras), `fix` (corrigir findings), `verify` (violações resolvidas?); selecionada por argumento (`/houndsman <capability>`). | `src/skill/<capability>.md` |
| **drift** | Divergência entre config/regras e o código real. Detectada pelo `doctor`. | `src/core/registry-check.ts` |
| **Jev** | Pré-análise **opcional** por LLM (seção 7). | `src/core/jev/` |

## 2. O fluxo em 4 passos

| Passo | Significado | Comando → artefatos |
| --- | --- | --- |
| **Passo 0 — contexto** | Coleta a PR via `gh` e resume objetivo/motivação/alterações. Opcional (falha-aberto). | `houndsman context` → `context.json`, `context-brief.md`, `context-summary.json` |
| **Passo 1 — preparar** | Classifica o diff, coleta o churn, roda o Jev e **grava um brief por watchdog**. | `houndsman` → `classification.json`, `candidates.json`, `briefs/`, `manifest.json` |
| **Passo 2 — revisar** | N subagentes (em **ondas**) executam os briefs e gravam os achados. | `findings/<watchdog>.json` |
| **Passo 3 — finalizar** | Valida, deduplica, agrupa e renderiza o relatório. | `houndsman --finalize` → `review.md` |
| **Passo 1.5** | Apelido do Jev dentro do Passo 1. | `candidates.json` |

> Por que comandos separados? Entre o Passo 1 e o 3 acontece trabalho de LLM (os subagentes).

## 3. Artefatos da revisão

Tudo em `.houndsman/.runs/<branch-slug>/` (default de `artifactDir`).

| Termo | Significado |
| --- | --- |
| **branch-slug** | Branch com `/` → `-` e minúscula; nomeia a pasta da execução (`feature/x` → `feature-x`). |
| **`classification.json`** | Classificação: watchdogs ativados por arquivo, status (A/M/D/R) e churn. |
| **`brief`** | O documento de instruções do watchdog (escopo, regras, docs, arquivos, candidatos). Renderizado por `renderBrief`. |
| **`briefs/<id>.md`** | O brief gravado em disco — o prompt do subagente. |
| **`findings/<id>.json`** | Achados **daquele** watchdog (schema em `OUTPUT-FORMAT.md`). |
| **finding / achado** | Uma violação: `rule`, `severity`, `file`, `line?`, `message`, `action`, `evidence?`. |
| **`manifest.json`** | Resumo da execução (watchdogs, arquivos, **orçamento**, **churn**, Jev, contexto). |
| **`candidates.json`** | Candidatos do Jev (indícios — **não** achados). |
| **`review.md`** | Relatório consolidado (o entregável da revisão). |
| **`review.<watchdog>.md`** | Relatório isolado por domínio (só quando há achados); indexado no consolidado. |
| **`state.json`** | Estado de triagem dos findings da run (ids, decisão, execução, histórico) — ver seção 11. |
| **`run.json`** | Status do run (`reviewing`/`review_done`/`fixing`/`fix_done`) + `startedAt`/`updatedAt` — exibido na UI; ver seção 11. |
| **`verify.md`** | Relatório do `findings verify` (resolvidos/persistem/incertos) — ver seção 11. |
| **`context.json`** | Payload bruto da PR via `gh` (ou marcador `available:false`). |
| **`context-brief.md`** | Instruções para o subagente que resume o contexto. |
| **`context-summary.json`** | Resumo curto da PR (objetivo/motivação/alterações). |
| **`OUTPUT-FORMAT.md`** | Contrato do JSON de saída do watchdog — o **único** output consumido pelo pipeline. |
| **`artifactDir`** | Pasta-raiz dos artefatos (default `.houndsman/.runs`). |

## 4. Campos de `classification.json` e `manifest.json`

| Termo | Significado |
| --- | --- |
| **`classification.watchdogs`** | Mapa `watchdogId → arquivos` que ele vai revisar (após exclusões e orçamento). |
| **`classification.files`** | Mapa `path → { status, oldPath? }`. |
| **`classification.churn`** | Mapa `path → { additions, deletions }`. |
| **`classification.unclassified`** | Arquivos que **nenhum** `classify` casou — revisar manualmente. |
| **`classification.excluded`** / **`excludedCount`** | Arquivos filtrados por `exclusions`. |
| **`classification.deleted`** | Deletados (sem conteúdo); viram candidatos a *breaking change*. |
| **`manifest.budget.maxFilesPerBrief`** | Teto de arquivos por brief usado na execução (default **40**). |
| **`manifest.budget.filesOverBudget`** | Total de arquivos que ficaram **fora** do orçamento. |
| **`manifest.watchdogs[].files`** | Arquivos efetivamente entregues ao watchdog (orçamento já aplicado). |
| **`manifest.overflow`** | ⚠️ **Não existe no topo.** O overflow é por watchdog: `manifest.watchdogs[].overflow` é a **contagem** de arquivos fora do orçamento daquele domínio. |
| **`manifest.watchdogs[].status`** | `pending` (findings ainda não gravado) ou `done`. |
| **`manifest.churn`** | Totais `{ additions, deletions }` do diff. |
| **`manifest.jev`** | `{ available, model, threshold, analyzedFiles, candidates, skipped }` ou `{ available:false, reason }`. |
| **`manifest.context`** | `{ summarized, source }` — se o Passo 0 rodou. |
| **`reviewedFiles`** | Arquivos que o watchdog **de fato** leu (dentro do `findings`). |
| **`skipped`** | Arquivos do domínio que o watchdog **não** leu + motivo (ex.: `"budget"`). |

## 5. Classificação e documentos

| Termo | Significado |
| --- | --- |
| **`classify` / `ClassifyRule`** | Padrão (regex) que decide se o watchdog cobre um arquivo. Sem casamento → `unclassified`. |
| **`type: "filename"`** (default) | O regex é aplicado ao **caminho** do arquivo. |
| **`type: "content"`** | O regex é aplicado ao **conteúdo** do arquivo (o motor lê o arquivo). |
| **`scope`** | Descrição textual do território do watchdog (contexto/documentação). |
| **`reviewFocus`** | Prioridade de leitura — o que o watchdog olha primeiro. |
| **`exclude`** | O que o watchdog **nunca** deve carregar. |
| **`breakingChange`** | Marca o watchdog como responsável por avaliar **deletados** do seu domínio. |
| **`contextFiles`** | Docs que o watchdog deve consultar. |
| **`docMappings`** | Regras `path → docs` do projeto. |
| **`alwaysIncludeDocs`** | Docs sempre incluídos nos briefs (default `["AGENTS.md"]`). |
| **`exclusions`** | Padrões de arquivos que **nunca** entram na revisão. |
| **`discoverDocs`** | Função que resolve quais docs entram no brief. |

## 6. Regras, polaridade e severidade

| Termo | Significado |
| --- | --- |
| **`Rule`** | Uma regra: `severity` + `text` (+ `jev` opcional). |
| **polaridade** | O texto **deve** começar com `Promover:` (deve acontecer) ou `Evitar:` / `Não` / `Nunca` (não deve acontecer). Sem prefixo → **aviso** no `doctor`. |
| **`Severity`** | `blocking` ❌ (bloqueia merge) > `attention` ⚠️ > `suggestion` 💡 > `nit` 🔎. |
| **`PROCEDURE`** | Os 5 passos do watchdog: FILTER → READ HEAD → GREP → DEEP-READ → CONCLUDE. |
| **dedupe** | Achados iguais por `(file, line, rule)` são unidos, somando os watchdogs que os apontaram. |
| **cobertura (coverage)** | Tabela `revisados / esperados` por watchdog — mostra o que faltou. |
| **`registry-check` / `doctor`** | Validações anti-drift da config (ids, `classify`, specs Jev, polaridade). |

## 7. Jev (pré-análise, Passo 1.5)

| Termo | Significado |
| --- | --- |
| **Jev** | Pré-análise opcional por LLM externo (TypeSafe "System One") que sugere indícios antes dos watchdogs. |
| **candidato (`jev.candidates`)** | Indício com `rule`, `file`, `severity`, `confidence` e `questionKey`. **NÃO é achado** — o watchdog confirma ou refuta. |
| **`noul`** | Tipo de pergunta "a violação ocorre?" → devolve probabilidade 0–1 (vira `confidence`). |
| **`choice` / `score`** | Outros tipos de pergunta Jev: escolha numa lista / nota numa rubrica. |
| **`JevRuleSpec`** | O campo opcional `jev` de uma `Rule`: declara como transformá-la em pergunta Jev (sem lista paralela). |
| **`threshold`** | Confiança mínima (**0.6**) para um indício virar candidato. |
| **`questionKey`** | Chave estável da pergunta: `<watchdogId>::rule-<índice>`. |
| **falha-aberto (fail-open)** | Sem chave / erro / timeout → `available:false`; a revisão segue idêntica. |
| **`TYPESAFE_API_KEY`** | Variável de ambiente que liga o Jev. O `doctor` valida a credencial com uma chamada mínima. |
| **`--no-jev`** | Desliga o Jev na execução. |

## 8. Diff, churn e orçamento

| Termo | Significado |
| --- | --- |
| **diff** | `git diff <base>...<head>` — a matéria-prima da revisão. **Nunca** vai inteiro para um watchdog. |
| **`DiffSource`** | O diff coletado **uma vez**: `byFile` (patch por arquivo) + `churn`. |
| **churn** | Linhas adicionadas/removidas por arquivo (`git diff --numstat`). Base da priorização. |
| **`--numstat`** | Forma de obter o churn (com `-z`: tolerante a renames, cópias e binários). |
| **budget (orçamento)** | Teto de arquivos por brief: `budgets.maxFilesPerBrief` (default **40**), priorizando maior churn. |
| **overflow** | Os arquivos que **sobraram** do orçamento (menor churn naquele domínio). |
| **Fora do orçamento** | Seção do brief com o overflow: o watchdog **não** deve lê-los, mas **deve** registrá-los em `skipped`. |
| **cobertura honesta** | O excedente nunca some: aparece como `faltam N` na tabela de Cobertura. |
| **rename / copy / delete** | Status do git; deletados viram *breaking change* (não têm conteúdo para ler). |
| **`concurrency.jev`** | Nº de chamadas Jev simultâneas (default **5**). |
| **onda (wave)** | Lote de subagentes despachados juntos (ex.: até 8) para não estourar rate limit. |

## 9. Camadas do código e da camada do projeto

| Termo | Significado |
| --- | --- |
| **`cli/`** | Camada imperativa com efeitos (`process.argv`/`exit`). |
| **`core/`** | Bibliotecas genéricas — sem `argv`/`exit`, sem efeito no import. |
| **`skill/`** | Markdown embarcado (assets copiados pelo `setup`). |
| **`tests/`** | Suíte project-agnóstica ("project fake"). |
| **snapshot de tipos** | `.houndsman/core/types.ts` — cópia dos tipos públicos para a camada não depender do pacote. Sincroniza com `houndsman update`. |
| **`defineWatchdog` / `defineHoundsmanConfig`** | Helpers de autoria (tipagem). O segundo **deriva** `watchdogIds` das chaves de `watchdogs`. |
| **auto-gerado vs usuário** | `setup` separa o que o `update` reescreve (`core/**`, `.gitignore`, ponteiros de skill) do que **nunca** toca (`watchdogs/`, `exclusions.ts`, `doc-mappings.ts`, `houndsman.config.ts`). |

## 10. Comandos e flags

| Termo | Significado |
| --- | --- |
| **`houndsman`** (sem comando) | Passo 1 — preparar (briefs + manifesto). |
| **`houndsman --finalize`** | Passo 3 — consolidar o relatório (`--report-only` é alias). |
| **`houndsman context`** | Passo 0 — contexto da PR via `gh`. |
| **`houndsman doctor`** | Anti-drift: valida config, ambiente e a credencial Jev via chamada mínima (`check` é alias). |
| **`houndsman watchdog <id>`** | Contexto de um watchdog (`--rules`, `--json`). |
| **`houndsman setup` / `update`** | Cria / sincroniza a camada do projeto. |
| **`houndsman test`** | Roda a suíte da lib. |
| **`houndsman findings <sub>`** | Triagem/correção dos findings (`list`/`show`/`set`/`done`/`reset`/`sync`/`summary`/`batch`/`path`). |
| **`houndsman server`** | UI local de triagem e leitura de artefatos (`--port`, `--host`, `--open`). |
| **`--base` / `--head`** | Extremos do diff (default `main` / `HEAD`). |
| **`--branch` / `--dir`** | Branch alvo / pasta de artefatos. |
| **`--clean`** | Descarta findings anteriores antes de preparar. |
| **`--fail-on-blocking`** | Exit `1` se houver `blocking` no `--finalize`. |
| **`--config <path>`** | Sobrepõe a descoberta do `houndsman.config.*`. |

## 11. Triagem e servidor (UI)

| Termo | Significado |
| --- | --- |
| **finding id** | Id curto aleatório de um finding, persistido no `state.json` e exibido no `review.md`. |
| **fingerprint** | Hash de `arquivo + regra + âncora` — identidade **estável** entre re-execuções do `--finalize`. |
| **âncora (anchor)** | Linha ofensora normalizada + contexto (linha anterior/seguinte). A `line` é **cache**, não identidade. |
| **line drift** | Deslocamento de linhas após um auto-fix; resolvido reancorando por conteúdo (`findings sync`). |
| **decision** | O que fazer: `pending` \| `execute` \| `ignore` (+ `comment` opcional). |
| **execState** | Em que pé está: `pending` \| `in_progress` \| `done` \| `stale`. |
| **stale** | Finding cuja âncora sumiu (fix aplicado/arquivo mudou); vira `done` se a decisão era `execute`. |
| **ausente (`present:false`)** | Finding que sumiu do último `--finalize`; o estado de triagem é preservado. |
| **grupo (`count`)** | Ocorrências byte-idênticas (mesmo trecho E mesmo contexto) compartilham id — limitação conhecida. |
| **reancoragem (reanchor)** | Recalcular a linha de cada finding lendo o arquivo atual (`core/finding-anchor.ts`). |
| **fila de correção** | Findings `decision: execute` ainda não `done` (presentes) — base do `fix`. |
| **lote (`findings batch`)** | Grupo atual paginado + lista dos demais grupos — unidade de trabalho do `fix`. |
| **escopo de correção** | Eixo de agrupamento do lote (`file`/`rule`/`watchdog`), escolhido automaticamente pela coesão da fila. |
| **run status** | `reviewing` → `review_done` → `fixing` → `fix_done` (em `run.json`). Toda ação mutante faz um **ping** (`updatedAt`); a UI deriva *timeout* de `updatedAt` (display-only, não é status). |
| **review incremental** | Prepare que revisa só o delta `reviewed.headSha..HEAD` (arquivos alterados) e carrega o resto (carry-over). |
| **carry-over** | Findings de arquivos inalterados preservados sem re-revisão (id/`foundAtSha` mantidos). |
| **`reviewed.headSha`** | Commit da última revisão (em `state.json`) — base do incremental e do diff focado do verify. |
| **`foundAtSha`** | Commit em que o achado foi observado (por finding) — base do diff focado do verify. |
| **verify / `findings verify`** | Confere se as violações foram resolvidas sem re-revisar: tier local (reancoragem) + Jev nos ambíguos. |
| **tier local / tier Jev** | As duas camadas do verify: a local é grátis e determinística; a do Jev confirma só os casos ambíguos. |

---

## Manutenção deste arquivo

- Um termo entra aqui quando aparece no vocabulário do código, dos briefs ou do relatório.
- Ao renomear um conceito, atualize **código + `AGENTS.md` + este glossário** no mesmo PR.
- Ver também: [`CONTRIBUTING.md`](./CONTRIBUTING.md) (princípios e arquitetura) e
  `src/skill/SKILL.md` (entry point) + `src/skill/{hunt,train,fix}.md` (capabilities).
