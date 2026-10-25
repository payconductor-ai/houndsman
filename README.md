# houndsman

Orquestrador de revisão de Pull Requests. Classifica o diff, despacha **watchdogs**
especializados por domínio (um subagente por watchdog) e consolida os achados em um
relatório único.

> Review de PR no piloto automático: alguém aprova no "LGTM" sem ler, um `catch {}` engole
> o erro e ninguém nota. Sexta às 18h a produção cobra a conta — e aí todo mundo lembra
> daquela linha.

![houndsman](assets/houndsman.png)

**Terminologia:** **houndsman** = orquestrador/treinador (CLI + motor) · **watchdog** = cada
agente especialista por domínio que audita o diff · **review/revisão** = o processo ·
**Jev** = pré-análise opcional. O vocabulário completo (brief, findings, manifest, budget,
overflow, churn, candidato…) está em [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

> Toda revisão tem duas etapas fixas: um **modelo de intenção** da PR
> (`business-summary.json`) e o revisor de fluxo **`general`**. Nenhum dos dois é
> configurável — o primeiro enriquece os briefs; o segundo procura gaps de lógica/domínio,
> não só violações de regra.

---

## Como iniciar

Você monta o **seu time de cães de caça** (os watchdogs), cada um farejando um domínio
diferente das PRs. O motor só coordena a caçada — as regras são problema seu.

### 1. Pré-requisitos

- **Bun** — runtime obrigatório.
- **git** — o diff usa `git diff <base>...<head>`.
- **gh** (Opcional) — Obtém contexto da PR e dispara comentários para o GitHub
- **`HOUNDSMAN_TYPE_SAFE_API_KEY`** (opcional) — pré-análise Jev.
- **`HOUNDSMAN_DEEP_SEEK_API_KEY`** (opcional) — features de IA (briefs, contexto, classificação, resumo técnico) e harness local `hunt`.
- **`HOUNDSMAN_OPENAI_API_KEY`** / **`HOUNDSMAN_ANTHROPIC_API_KEY`** (opcional) — apenas se
  `ai.provider` for `openai`/`anthropic`.
- **maki** (opcional) — só para o harness local `houndsman hunt`; a skill `/houndsman hunt`
  não precisa dele. Instale com `houndsman hunt install`.

> Coloque as chaves em um `.env` na raiz do projeto; o Bun carrega automaticamente.

### 2. Instale o CLI (global)

```bash
bun add -g @payconductor/houndsman
```

### 3. Configure o projeto (uma vez)

Na raiz do projeto:

```bash
bun run houndsman setup
```

Cria a camada `.houndsman/`, que é **autocontida** (não instala nada no seu projeto):

| Caminho | Dono | O que é |
|---|---|---|
| `houndsman.config.ts` | você | Configuração do projeto (um objeto de dados) |
| `.houndsman/watchdogs/` | você | Suas regras — começa com um watchdog `default` (fallback) e um `example` |
| `.houndsman/exclusions.ts` | você | Arquivos que nunca entram na revisão |
| `.houndsman/doc-mappings.ts` | você | path → documentação de contexto |
| `.houndsman/core/**` | auto | Tipos + docs do skill (sincronizados por `houndsman update`) |

> O `setup` já cria a camada inicial com um watchdog `default` (fallback, cobre arquivos sem
> domínio) e um `example` — troque o exemplo pelas regras reais do seu projeto (ou use
> `/houndsman train`).

### 4. Escreva suas regras

Edite `.houndsman/watchdogs/` — veja [Escrevendo boas regras](docs/AVANCADO.md#escrevendo-boas-regras).

### 5. Valide

```bash
bun run houndsman doctor
```

### 6. Rode a primeira revisão

No seu agente (Claude Code / agents), invoque o skill:

```
/houndsman hunt
```

O skill orquestra tudo e persiste o relatório no storage global (SQLite em
`<HOUNDSMAN_HOME>/houndsman.db`); a UI lê os artefatos direto do storage. Não precisa rodar
nenhum script à mão.

#### Alternativa: rodar 100% pelo CLI (opcional)

Quem não quer usar um agente externo pode executar a mesma revisão pelo terminal, com o
maki como harness local. A instalação é única e fica fora do projeto:

```bash
houndsman hunt install        # baixa o maki fixado em <HOUNDSMAN_HOME>/tools/maki
houndsman hunt doctor         # diagnóstico (não falha se o maki não existir)
houndsman hunt --pr 456       # prepare → maki (1 processo por brief) → finalize
```

Os dois caminhos produzem os mesmos artefatos e usam o mesmo staging. A skill
`/houndsman hunt` continua sendo o caminho canônico para agentes externos.

### 7. Várias PRs ao mesmo tempo (worktrees)

Cada revisão pode rodar em um **worktree dedicado** (detached no commit da PR), sem
checkout no clone principal e sem bloquear a revisão das outras PRs:

```bash
houndsman --pr 123                 # cria/reusa o worktree e prepara os briefs
houndsman --pr 123 --finalize      # consolida o relatório
houndsman worktree list            # worktrees ativos
houndsman worktree remove feature/x
```

Os worktrees ficam em `<repo>/.houndsman/worktrees/<repo>/<branch>` (ignorados pelo git) e
são removidos manualmente (ou com `houndsman worktree prune`). Ficam **dentro do
workspace** de propósito: agentes de codificação com permissão escopada à pasta aberta
conseguem ler/executar sem pedir autorização. Para voltar ao diretório global, use
`worktrees: { location: "home" }` no `houndsman.config.ts`. A UI (`houndsman server`)
mostra o worktree ativo de cada PR e permite criá-lo pela sidebar.

---

## O fluxo de trabalho

```
/houndsman hunt
   ├─ Passo 0  contexto da PR (gh, opcional)
   ├─ Passo 1  classifica o diff → briefs por watchdog (incremental quando possível)
   ├─ Passo 2  N subagentes revisam em paralelo
   ├─ Passo 3  consolida em review.md + triagem no storage
   ├─ Passo 4  valida na UI (server) e marca os achados a executar
   ├─ Passo 5  fix corrige o grupo atual → status fix_done
   └─ Passo 6  verify confere o que resolveu, sem re-revisar
```

O skill tem **4 capabilities**, todas em `/houndsman`:

- **`hunt`** — revisa a PR.
- **`train`** — mantém/atualiza as regras dos watchdogs.
- **`fix`** — corrige os findings marcados.
- **`verify`** — confere se as violações foram resolvidas, sem re-revisar.

- Revisar outra branch: `/houndsman hunt feature/minha-branch`.
- Validar na UI: `houndsman server --open` — marque os findings a executar (`execute`).

---

## Validando os findings (opcional)

Você decide o que fazer com cada finding pela **UI local**, informando se quer `Executar` ou `Ignorar`

```bash
bun run houndsman server --open     # UI: triar, comentar, marcar feito, ler artefatos
```

> A partir da 2ª revisão o prepare é **incremental**: revisa apenas os arquivos que mudaram desde
> a última revisão. `--full` força o review completo.

---

## Mantendo a configuração

- **Persistência** → por default, SQLite global em `<HOUNDSMAN_HOME>/houndsman.db`
  (`HOUNDSMAN_HOME` sobrescreve o diretório de dados). Caso queira storage base em arquivos, na config, troque provider para `file`:

  ```ts
  export const houndsmanConfig = {
    // ...
    storage: { provider: "file", path: "./houndsman/runs" },
  };
  ```

- **Alterar regras** → use a capability **`train`** (`/houndsman train`). Ela prova no código
  que o padrão existe (evidência) antes de editar e roda as validações.
- **Atualizou a lib?** Sincronize os arquivos auto-gerados sem tocar nas suas regras:

  ```bash
  bun run houndsman update
  bun run houndsman doctor
  ```

  O `update` reescreve **só** `.houndsman/core/**` e `.houndsman/.gitignore`. Seus arquivos
  (`watchdogs/`, `exclusions.ts`, `doc-mappings.ts`, `houndsman.config.ts`) nunca são tocados.

---

## Documentação

- `docs/AVANCADO.md` — como funciona por dentro (diagrama do fluxo e onde o Jev entra),
  referência de comandos e boas práticas para escrever regras.
- `docs/GLOSSARY.md` — glossário do vocabulário de domínio (brief, findings, manifest,
  budget, overflow, churn, candidato, Jev…): o que cada termo significa **neste** projeto.
- `docs/CONTRIBUTING.md` — arquitetura, fluxos internos, princípios e desenvolvimento da
  lib (para quem vai contribuir).

- `src/skill/SETUP.md` — referência de configuração passo a passo.
- `src/skill/SKILL.md` — entry point do skill `/houndsman` (capabilities).
- `src/skill/hunt.md` — capability `hunt` (revisão de PR).
- `src/skill/train.md` — capability `train` (manutenção das regras).
- `src/skill/fix.md` — capability `fix` (correção dos findings).
