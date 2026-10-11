# houndsman — {{projectName}} (v1)

> **Documento canônico do skill `/houndsman`.** Os `SKILL.md` de cada harness
> (`.agents/skills/houndsman/` e `.claude/skills/houndsman/`) são apenas ponteiros para cá.

Revisão de PR: classificação de arquivos → revisão paralela por domínio → consolidação.
O motor é o CLI **`houndsman`**; as regras do projeto ficam em `houndsman.config.ts` + `houndsman/`.

## Quem executa o quê

- **Você** só invoca o skill: `/houndsman`. Não precisa rodar nenhum script à mão.
- **O skill** orquestra: executa o CLI `houndsman` e despacha os subagentes.
- **O CLI** tem passos distintos, um comando cada:

| Passo | Comando | Quem roda | Resultado |
|---|---|---|---|
| 0. Contexto | `houndsman context` | subagente | `context.json` + `context-brief.md` → `context-summary.json` |
| 1. Preparar | `houndsman` | skill | `classification.json` + `candidates.json` + `briefs/` + `manifest.json` |
| 2. Revisar | *(subagentes)* | skill (via `runSubagent`) | `findings/<revisor>.json` (um por revisor) |
| 3. Finalizar | `houndsman --finalize` | skill | `review.md` |

> Por que comandos separados? Entre o passo 1 e o 3 acontece trabalho de LLM (os subagentes).

**Arquitetura:**

- N revisores especializados por domínio de negócio.
- **Cada revisor declara o que revisa** (`classify` em `.houndsman/reviewers/<id>.ts`:
  `{ type?: "filename" | "content", value }` — `value` é sempre regex; `filename`
  (padrão) casa o caminho, `content` casa o conteúdo do arquivo). Não há arquivo de
  classificação à parte nem fallback: arquivo fora dos padrões fica `unclassified`.
- **Fonte única de verdade do projeto:** `houndsman.config.ts` (`ReviewConfig`) +
  `.houndsman/` (`reviewers/<id>.ts`: regras + escopo + foco + `classify`;
  `exclusions.ts`: filtros; `doc-mappings.ts`: docs).
- **O motor genérico** vive no pacote `houndsman` (`core/` + `cli/`). O markdown do skill
  vive em `src/skill/`.
- **As regras refletem os padrões APLICADOS hoje** — não validar práticas que o projeto
  não adota. Regra sem aplicação real no código gera falso positivo.
- Cada revisor recebe apenas seus arquivos relevantes (brief pronto) — nunca o diff completo.
- Saída estruturada (JSON) por revisor → consolidada e deduplicada automaticamente.

## Quando Usar

- Revisar PR antes de merge
- Code review de feature branch
- Validar mudanças antes de push

---

## Passo 0 — Contexto da PR (subagente)

O contexto vem da **descrição da PR** via GitHub CLI (`gh`), quando disponível e logado.
Um subagente executa o CLI e resume:

```
Você é o subagente de contexto do houndsman. Execute `houndsman context`;
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
houndsman --base main
```

Gera em `.houndsman/.runs/<branch-slug>/`:

| Artefato | Conteúdo |
|---|---|
| `classification.json` | Revisores ativados por arquivo + status (A/M/D/R) |
| `candidates.json` | Indícios da pré-análise Jev (regra + arquivo + confiança) |
| `briefs/<reviewer>.md` | Instruções prontas para cada subagente |
| `manifest.json` | Resumo: revisores, arquivos, deletados, status, contexto, Jev |

**Excluídos automaticamente:** lock files, `dist/`, `build/`, `.env*`, imagens, source
maps (padrões do projeto em `.houndsman/exclusions.ts`).
**Deletados:** não entram como conteúdo; vão para o brief de revisores com
`breakingChange` como candidatos a **breaking change**.

### Pré-análise Jev (Passo 1.5, opcional)

Se `TYPESAFE_API_KEY` estiver definida, cada arquivo é avaliado pelo modelo **Jev** contra
as regras atômicas dos revisores. Respostas acima do limiar viram **candidatos** em
`candidates.json` e entram no brief como *warm start* — o subagente **confirma ou refuta**.

- **Não é achado**: candidatos não bloqueiam.
- **Falha-aberto**: sem chave / erro / timeout → `available:false`; a revisão segue idêntica.
- Desativar: `houndsman --no-jev`.

---

## Passo 2 — Revisar (skill despacha os subagentes)

Um subagente por brief, todos no mesmo bloco de tool calls. O prompt é o próprio brief:

```
Leia e execute o brief: .houndsman/.runs/<branch-slug>/briefs/<reviewer-id>.md
Você é o revisor <reviewer-id> do {{projectName}}.
```

Cada subagente grava `findings/<reviewer-id>.json` (schema `.houndsman/skill/OUTPUT-FORMAT.md`).
Sem achados → `"findings": []` (arquivo obrigatório).

**NUNCA enviar:** `git diff` completo · histórico de commits · arquivos de outros domínios ·
`AGENTS.md` completo (já está no contexto global).

---

## Passo 3 — Finalizar (skill executa)

```bash
houndsman --finalize
```

Falha com mensagem clara se faltar algum `findings/<revisor>.json`. Quando todos existem:
1. Valida o schema de cada JSON
2. Deduplica achados por `(file, line, rule)` mesclando revisores sobrepostos
3. Agrupa por severidade: ❌ blocking > ⚠️ attention > 💡 suggestion
4. Grava `.houndsman/.runs/<branch-slug>/review.md` + tabela de cobertura
5. Anexa os candidatos Jev não confirmados em `🔎 Candidatos não verificados` (não bloqueiam)

---

## Estrutura do Relatório

```markdown
# Review — [branch]

**Data:** YYYY-MM-DD
**Revisores ativos:** [lista]
**Achados:** N bloqueantes · N atenção · N sugestões

## Contexto da PR
**PR:** #123 Título — url
**Branch:** `feature/x` → `main`
**Objetivo:** ...
**Resumo das alterações:**
- ...

## ❌ blocking
- **<regra>** — `arquivo:linha` · _<revisores>_
  <mensagem>
  **Ação:** <ação>

## Cobertura
| Revisor | Arquivos revisados | Findings |
|---|---|---|

## Conclusão
**Status:** ✅ Aprovado / ⚠️ Aprovado com Ressalvas / ❌ Mudanças Necessárias
```

---

## Fluxo Completo

```
houndsman context (gh)         ──►  context.json ──► subagente ──► context-summary.json
        ↓
git diff --name-status (base...head)
        ↓
[1] houndsman                  ──►  classification.json + candidates.json + briefs/ + manifest.json
        ↓
[2] N subagentes em paralelo   ──►  findings/<revisor>.json
        ↓
[3] houndsman --finalize       ──►  review.md
```

---

## Invocação

```
/houndsman
/houndsman feature/add-webhook-retry
```

Se a branch não for informada, detecta com `git branch --show-current`. Base do diff: `main`.

**Comandos do CLI:**

| Comando | Função |
|---|---|
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman` | Passo 1 — preparar (briefs + manifesto) |
| `houndsman --finalize` | Passo 3 — gerar o relatório |
| `houndsman reviewer <id>` | Contexto de um revisor (`--json`, `--rules`) |
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman doctor` | Valida a configuração e o ambiente (anti-drift) |
| `houndsman test` | Suíte de testes da lib |

---

## Anti-padrões

- ❌ Enviar git diff completo para qualquer revisor
- ❌ Ativar revisores sem arquivos no seu domínio
- ❌ Carregar documentação que o revisor não precisa
- ❌ Revisar arquivos gerados (lock files, builds, migrations)
- ❌ Escrever markdown livre em vez do JSON de `OUTPUT-FORMAT.md`
- ❌ Revisar arquivos `deleted` (não têm conteúdo) em vez de tratá-los como breaking change
- ❌ Comentários genéricos ("código bom", "pode melhorar")
- ❌ Sugestões de estilo triviais
- ❌ Reescrever código completo — apenas apontar direção
- ❌ Inventar objetivo/motivação da PR — o resumo vem **só** do `gh`; sem `gh`, omitir a seção

---

## Manutenção das Regras

> Alterar qualquer regra (adicionar, ajustar severidade, remover, corrigir escopo) → usar o
> skill **`update-houndsman`** (`src/skill/update-houndsman.md`).
> Regra de ouro: só é regra o que o projeto **aplica hoje** — prove com evidência no código.
> Após qualquer alteração, rodar `houndsman doctor` (anti-drift) + `houndsman test` + `ci:fix` + `ci:check`.

---

## Performance Esperada

| Tamanho do PR | Revisores | Tempo |
|---|---|---|
| Pequeno (500 linhas) | 2-4 | ~30-60s |
| Médio (5k linhas) | 4-7 | ~1-2 min |
| Grande (50k linhas) | 7-10 | ~3-5 min |
| Enorme (300k linhas) | 10-15 | ~5-8 min |
