# houndsman — {{projectName}} · `hunt` (revisão de PR)

> **Documento canônico da capability `hunt`.** O entry point do skill é o `SKILL.md`
> (`.agents/skills/houndsman/SKILL.md` e `.claude/skills/houndsman/SKILL.md`).

Revisão de PR: classificação de arquivos → revisão paralela por domínio → consolidação.
Invocação: `/houndsman` (default), `/houndsman hunt` ou `/houndsman hunt pr 456`.
O motor é o CLI **`houndsman`**; as regras do projeto ficam em `houndsman.config.ts` +
`.houndsman/`.

## Dois modos de execução

| Modo | Quem usa | Requisitos | Quem despacha os briefs |
|---|---|---|---|
| **Skill `/houndsman hunt`** (padrão) | agente externo (Copilot/Claude/etc.) | nenhum | o próprio agente, via subagentes |
| **CLI `houndsman hunt`** | operador/CI, sem agente | `houndsman hunt install` uma vez | o houndsman, via maki headless |

Os dois modos produzem os mesmos artefatos, usam o mesmo staging e o mesmo ciclo
`prepare → findings → finalize`. Nada muda no fluxo abaixo para quem usa a skill.

> **Se você é o agente executando esta skill, NÃO rode `houndsman hunt`.** Ele instala/usa o
> maki e despacha outro harness. Siga os passos 0–3 normalmente; o comando CLI é para quem
> quer rodar tudo no terminal.

## Alvo da revisão

Traduza o pedido do usuário para flags **antes** de começar:

| Pedido | Alvo | Flag |
|---|---|---|
| “revise a PR 456”, “#456”, URL `.../pull/456` | PR | `--pr 456` |
| “revise a branch feature/x” | branch | `--branch feature/x` |
| “revise esta PR / o que mudou” | branch atual | *(sem flag)* |

> **Se o alvo é uma PR, use worktree.** Rode `houndsman --pr 456` (não `houndsman`), nunca faça
> checkout no clone principal e use o caminho impresso na saída como raiz dos subagentes.
> Isso permite revisar outras PRs em paralelo, cada uma na sua árvore.

**Quando usar:** revisar PR antes de merge · code review de feature branch · validar
mudanças antes de push.

## Quem executa o quê

- **Você** só invoca o skill: `/houndsman [hunt]`. Não precisa rodar nenhum script à mão.
- **O skill** orquestra: executa o CLI `houndsman` e despacha os subagentes.
- **O CLI** tem passos distintos, um comando cada:

| Passo | Comando | Quem roda | Resultado |
|---|---|---|---|
| 0. Contexto | `houndsman context` | subagente | `context.json` + `context-brief.md` → `context-summary.json` |
| 1. Preparar | `houndsman` | skill | `classification.json` + `candidates.json` + `briefs/` + `manifest.json` |
| 2. Revisar | *(subagentes)* | skill (via `runSubagent`) | `findings/<watchdog>.json` (um por watchdog) |
| 3. Finalizar | `houndsman --finalize` | skill | `review.md` + triagem/status no storage |

> Por que comandos separados? Entre o passo 1 e o 3 acontece trabalho de LLM (os subagentes).
> Depois do passo 3, a correção dos achados é a capability **`fix`** — ver `fix.md`.

**Arquitetura:**

- N watchdogs especializados por domínio de negócio.
- **Cada watchdog declara o que revisa** (`classify` em `.houndsman/watchdogs/<id>.ts`:
  `{ type?: "filename" | "content", value }` — `value` é sempre regex; `filename`
  (padrão) casa o caminho, `content` casa o conteúdo do arquivo). Não há arquivo de
  classificação à parte nem fallback: arquivo fora dos padrões fica `unclassified`.
- **Fonte única de verdade do projeto:** `houndsman.config.ts` (`HoundsmanConfig`) +
  `.houndsman/` (`watchdogs/<id>.ts`: regras + escopo + foco + `classify`;
  `exclusions.ts`: filtros; `doc-mappings.ts`: docs).
- **O motor genérico** vive no pacote `@payconductor/houndsman` (`core/` + `cli/`). O markdown
  do skill vive em `src/skill/`.
- **As regras refletem os padrões APLICADOS hoje** — não validar práticas que o projeto
  não adota. Regra sem aplicação real no código gera falso positivo.
- Cada watchdog recebe apenas seus arquivos relevantes (brief pronto) — nunca o diff completo.
- O brief traz o **escopo do diff** (símbolos alterados e faixas revisáveis); achado fora
  dessas faixas é código pré-existente, não escopo desta revisão.
- Saída estruturada (JSON) por watchdog → consolidada e deduplicada automaticamente.

---

## Passo 0 — Contexto da PR (subagente)

O contexto vem da **descrição da PR** via GitHub CLI (`gh`), quando disponível e logado.
Um subagente executa o CLI e resume:

```
Você é o subagente de contexto do houndsman. Execute `houndsman context --pr 456`
(ou `houndsman context --worktree <path>` se o prepare já criou o worktree);
leia o `context-brief.md` indicado na saída; siga as instruções e grave
`context-summary.json`. Retorne `objective`/`motivation`/`changeSummary` ou "indisponível".
```

- O CLI detecta `gh` (**ausente/sem login/sem PR** → grava `available:false` e sai com código 0).
- O subagente resume em `context-summary.json`: `objective` (1 frase, ≤ 200 chars),
  `motivation` (1 frase, ≤ 240 chars) e `changeSummary` (≤ 4 bullets, ≤ 160 chars cada),
  em pt-BR e baseado **somente** no `context.json`. **Curto de propósito.**
- Sem contexto → a revisão segue normalmente e a seção é omitida (registrado no `manifest.json`).

---

## Passo 1 — Preparar (skill executa)

```bash
houndsman --pr 456          # alvo = PR (cria/reusa o worktree)
houndsman --base main       # alvo = branch atual (clone principal)
```

Quando o alvo é uma PR, o prepare consulta a PR via `gh`, busca `refs/pull/<n>/head`, cria o
worktree **detached** em `<repo>/.houndsman/worktrees/<repo>/<branch>` e imprime o caminho.
Cada brief passa a trazer `**Worktree:** <path>` — essa é a raiz que os subagentes devem ler.
Guarde também a linha `PR #456 — <head> → <base>`: `<head>` é a branch a usar em
`status ping`, `findings` e `verify`.

Grava os artefatos no **storage global** (SQLite em `<HOUNDSMAN_HOME>/houndsman.db`) e o
staging dos subagentes em `<HOUNDSMAN_HOME>/work/<reviewId>/`:

| Artefato | Conteúdo |
|---|---|
| `classification.json` | Watchdogs ativados por arquivo + status (A/M/D/R) + churn (storage) |
| `ast-summary.json` | Fatos estruturais + delta por arquivo (AST TS/JS) (storage) |
| `ast-impact.json` | Importadores reversos e exports públicos alterados (storage) |
| `candidates.json` | Indícios da pré-análise Jev (regra + arquivo + confiança) (storage) |
| `briefs/<watchdog>.md` | Instruções prontas para cada subagente (staging + storage, para auditoria) |
| `manifest.json` | Resumo: watchdogs, arquivos, deletados, status, contexto, Jev, orçamento (storage) |

> O prepare imprime o caminho absoluto do diretório de briefs e cada brief traz o
> `outputPath` do JSON que o subagente deve gravar. Briefs e contexto também ficam
> persistidos no storage para auditoria; o staging é limpo após o `--finalize`.
>
> **AST (TS/JS, ligado por padrão):** cada brief ganha a seção `Estrutura (AST)` com
> símbolos adicionados/removidos/alterados, assinaturas e imports; o impacto reverso
> (quem importa os arquivos alterados) aparece como mapa de leitura. É fail-open:
> sem grammar/ABI, a revisão segue só com regex. Desative com `--no-ast`.

**Excluídos automaticamente:** lock files, `dist/`, `build/`, `.env*`, imagens, source
maps (padrões do projeto em `.houndsman/exclusions.ts`).
**Deletados:** não entram como conteúdo; vão para o brief de watchdogs com
`breakingChange` como candidatos a **breaking change**.

### Orçamento por brief (PRs grandes)

O motor coleta o diff **uma única vez** (`git diff` + `git diff --numstat`) e classifica
com **churn** (linhas adicionadas/removidas) por arquivo — o custo não cresce com o nº de
arquivos da PR. Cada brief recebe no máximo `budgets.maxFilesPerBrief` arquivos (default 40),
**priorizados pelo maior churn**:

- O excedente vai para a seção **Fora do orçamento (NÃO revisar)** do brief e o watchdog deve
  registrá-lo em `skipped` — a tabela de **Cobertura** mostra o que ficou de fora (nunca some
  silenciosamente).
- Isso mantém o contexto do subagente limitado mesmo num PR de 10k linhas com centenas de
  arquivos num único domínio.
- Ajuste em `houndsman.config.ts`: `budgets: { maxFilesPerBrief: 60 }` e
  `concurrency: { jev: 8 }`. Valores não-positivos caem no default (o `doctor` avisa).

### Pré-análise Jev (Passo 1.5, opcional)

Se `HOUNDSMAN_TYPE_SAFE_API_KEY` estiver definida, cada arquivo é avaliado pelo modelo **Jev** contra
as regras atômicas dos watchdogs. Respostas acima do limiar viram **candidatos** em
`candidates.json` e entram no brief como *warm start* — o subagente **confirma ou refuta**.

- **Não é achado**: candidatos não bloqueiam.
- **Opcional**: sem chave / erro / timeout → `available:false`; a revisão segue idêntica.
- Desativar: `houndsman --no-jev`.

### Review incremental (da 2ª revisão em diante)

Cada `--finalize` grava o **commit revisado** (`reviewedSha` da review no storage). No prepare
seguinte, se o `HEAD` descende desse commit (sem rebase), o motor revisa **só o delta** — os
arquivos alterados desde a última revisão — e **carrega** os findings dos arquivos inalterados
(carry-over), sem re-revisá-los. O `manifest.json` traz o bloco `incremental` (`from`,
`changedFiles`, `carried`) e o `review.md` abre com um aviso.

- Sem mudanças desde a última revisão → **no-op**: o prepare não gera briefs nem reescreve
  artefatos (classification, manifest, review.md), e o `--finalize` também vira no-op — pare o
  fluxo aí (nenhum subagente é despachado).
- Rebase/force-push (histórico reescrito) → cai automaticamente no **review completo**.
- Forçar completo: `houndsman --full` (ou `--clean`, que também descarta a triagem anterior).

> Custo: o LLM só é gasto nos arquivos que mudaram desde a última revisão — não na PR inteira.
> Re-rodar `/houndsman` no mesmo commit **não** re-revisa a PR; use `--full` para isso.

---

## Passo 2 — Revisar (skill despacha os subagentes)

Um subagente por brief. Despache em **ondas** (ex.: até 8 subagentes por bloco de tool
calls) — evita estourar limites de taxa quando há muitos watchdogs. O prompt é o próprio brief:

> **Heartbeat:** antes de despachar cada onda, rode `houndsman status ping`. A UI usa esse
> sinal (e não `updatedAt`) para saber que a execução está viva; sem ping por 10 min ela
> mostra "Timeout na revisão".

```
Leia e execute o brief: <caminho absoluto impresso pelo prepare>/briefs/<watchdog-id>.md
Você é o watchdog <watchdog-id> do {{projectName}}.
Use como raiz de leitura o **Worktree:** indicado no brief (nunca o clone principal).
```

Cada subagente grava o `outputPath` indicado no brief (schema `.houndsman/core/skill/OUTPUT-FORMAT.md`).
Sem achados → `"findings": []` (arquivo obrigatório). Arquivos na seção **Fora do orçamento**
não são lidos: registre-os em `skipped`.

**NUNCA enviar:** `git diff` completo · histórico de commits · arquivos de outros domínios ·
`AGENTS.md` completo (já está no contexto global).

---

## Passo 3 — Finalizar (skill executa)

```bash
houndsman --pr 456 --finalize     # alvo = PR (reusa o worktree gravado)
houndsman --finalize              # alvo = branch atual
```

Falha com mensagem clara se faltar algum `findings/<watchdog>.json` no staging. Quando todos existem:
1. Valida o schema de cada JSON
2. Deduplica achados por `(file, line, rule)` mesclando watchdogs sobrepostos
3. Grava um `review.<watchdog>.md` por watchdog com achados e indexa no `review.md`
   (**Relatórios por domínio**) — mantém o relatório consolidado enxuto
4. Grava o `review.md` abrindo pelo **sumário**: contexto, relatórios por domínio, cobertura e
   conclusão — antes dos achados
5. Agrupa os achados por severidade (❌ blocking > ⚠️ attention > 💡 suggestion > 🔎 nit) e
   **por arquivo** dentro de cada severidade (navegabilidade em PRs grandes)
6. Anexa os candidatos Jev não confirmados em `🔎 Candidatos não verificados` ao final
   (não bloqueiam)
7. Persiste a **triagem** no storage — um `id` curto e um `fingerprint` de conteúdo por
   finding, preservados entre execuções9. Marca como **`done`** os findings que sumiram do relatório (corrigidos manualmente entre
   revisões) e **resolve as conversas correspondentes no GitHub** — só as ainda abertas, e
   falha-aberto (sem `gh`/PR o relatório segue igual)
Após finalizar, corrija os achados com a capability **`fix`** (`fix.md`): a UI ou os
comandos `findings` levam do achado à correção.

---

## Estrutura do Relatório

```markdown
# Review — [branch]

**Data:** YYYY-MM-DD
**Watchdogs ativos:** [lista]
**Achados:** N bloqueantes · N atenção · N sugestões · N nits

## Contexto da PR
**PR:** #123 Título — url
**Branch:** `feature/x` → `main`
**Objetivo:** ...
**Resumo das alterações:**
- ...

## Relatórios por domínio
| Watchdog | Achados | Revisados | Relatório |
|---|---|---|---|

## Cobertura
| Watchdog | Arquivos revisados | Findings |
|---|---|---|

## Conclusão
**Status:** ✅ Aprovado / ⚠️ Aprovado com Ressalvas / ❌ Mudanças Necessárias

## ❌ blocking
### `src/routes/order-route.ts`
- **<regra>** — `src/routes/order-route.ts:5` · _<watchdogs>_
  <mensagem>
  **Ação:** <ação>

## 🔎 Candidatos não verificados (Jev)   ← se houver, sempre ao final
```

> O **sumário** (relatórios por domínio, cobertura e conclusão) vem **antes** dos achados;
> os pontos específicos ficam no fim.

---

## Fluxo Completo

```
houndsman context (gh)         ──►  context.json ──► subagente ──► context-summary.json
        ↓
git diff --name-status (base...head)
        ↓
[1] houndsman                  ──►  storage (classification/candidates/manifest) + briefs/ no staging
        ↓
[2] N subagentes em paralelo   ──►  findings/<watchdog>.json no staging
        ↓
[3] houndsman --finalize       ──►  review.md + triagem no storage (review_done)
        ↓
[4] server (UI)                ──►  validar a revisão + marcar decision: execute
        ↓
[5] fix                        ──►  correções + triagem/status no storage (fix_done)
```

---

## Invocação

```
/houndsman
/houndsman hunt
/houndsman hunt feature/add-webhook-retry
```

Se a branch não for informada, detecta com `git branch --show-current`. Base do diff: `main`.

**Comandos do CLI usados no `hunt`:**

| Comando | Função |
|---|---|
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman` | Passo 1 — preparar (briefs + manifesto; incremental quando possível) |
| `houndsman status ping` | Passo 2 — heartbeat da execução (antes de cada onda) |
| `houndsman --finalize` | Passo 3 — gerar o relatório |
| `houndsman watchdog <id>` | Contexto de um watchdog (`--json`, `--rules`) |

Flags do review: `--base` · `--head` · `--branch` · `--clean` · `--full` (força
completo) · `--no-jev` · `--no-ast` · `--fail-on-blocking` (com `--finalize`).

> Persistência: SQLite global em `<HOUNDSMAN_HOME>/houndsman.db`. O staging dos subagentes
> (`briefs/`, `findings/`, contexto) vive em `<HOUNDSMAN_HOME>/work/<reviewId>/` e é limpo
> depois do `--finalize`.

---

## Harness local (opcional, fora da skill)

Para rodar a revisão inteira pelo terminal, sem agente externo, o mesmo `hunt` existe como
comando. A instalação é única e fica fora do projeto:

```bash
houndsman hunt install            # baixa o maki fixado em <HOUNDSMAN_HOME>/tools/maki
houndsman hunt doctor             # diagnóstico (não falha se o maki não existir)
houndsman hunt --pr 456           # prepare → um processo maki por brief → finalize
houndsman hunt --pr 456 --allow-partial  # finaliza mesmo se algum watchdog falhar
```

- Reaproveita a credencial já configurada (`HOUNDSMAN_DEEP_SEEK_API_KEY` → `DEEPSEEK_API_KEY`)
  e o modelo de `ai.model` (default `deepseek/deepseek-v4-pro`).
- O watchdog **não recebe escrita**: o maki devolve o JSON na resposta final e o houndsman
  valida e grava `findings/<watchdog>.json`. `bash`, rede e edição ficam negados.
- Sem maki instalado, nada muda para a skill: `setup`, `doctor` e `/houndsman hunt` seguem
  funcionando.
- O relatório do harness fica em `hunt-report.json` (sessões, custo e tokens por watchdog).

---

## Anti-padrões

- ❌ Enviar git diff completo para qualquer watchdog
- ❌ Ativar watchdogs sem arquivos no seu domínio
- ❌ Revisar arquivos marcados como **Fora do orçamento** (registre-os em `skipped`)
- ❌ Carregar documentação que o watchdog não precisa
- ❌ Revisar arquivos gerados (lock files, builds, migrations)
- ❌ Escrever markdown livre em vez do JSON de `OUTPUT-FORMAT.md`
- ❌ Revisar arquivos `deleted` (não têm conteúdo) em vez de tratá-los como breaking change
- ❌ Comentários genéricos ("código bom", "pode melhorar")
- ❌ Sugestões de estilo triviais
- ❌ Reescrever código completo — apenas apontar direção
- ❌ Inventar objetivo/motivação da PR — o resumo vem **só** do `gh`; sem `gh`, omitir a seção

---

## Manutenção das Regras

> Alterar qualquer regra (adicionar, ajustar severidade, remover, corrigir escopo) → capability
> **`train`** (`/houndsman train`, doc `train.md`).
> Regra de ouro: só é regra o que o projeto **aplica hoje** — prove com evidência no código
> (regra negativa com 0 ocorrências = seguida → **manter**).
> Após qualquer alteração, rodar `houndsman doctor`. (`houndsman test` e `ci:fix`/`ci` são
> comandos da **lib**, não do projeto consumidor.)

---

## Performance Esperada

| Tamanho do PR | Watchdogs | Tempo |
|---|---|---|
| Pequeno (500 linhas) | 2-4 | ~30-60s |
| Médio (5k linhas) | 4-7 | ~1-2 min |
| Grande (50k linhas) | 7-10 | ~3-5 min |
| Enorme (300k linhas) | 10-15 | ~5-8 min |

> O custo de coleta é **constante** (2 execuções de `git`), independente do nº de arquivos.
> Em PRs muito grandes, o limitante é o nº de subagentes (ondas) e o orçamento por brief —
> não o diff. Ajuste `budgets.maxFilesPerBrief` para revisar mais/menos arquivos por domínio.
