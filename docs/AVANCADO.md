# houndsman — guia avançado

> Tópicos além do [README](../README.md): como o motor funciona por dentro, onde o Jev entra,
> referência de comandos e boas práticas para escrever regras.
>
> IA e harness nativo (`houndsman hunt`): [`HARNESS.md`](HARNESS.md).

---

## Como a mágica funciona

O `/houndsman` é um **maestro, não um revisor**. O CLI não lê o diff procurando bugs — isso é
trabalho dos subagentes (watchdogs). O que ele entrega é o *encanamento*: transforma um diff
bruto em **contextos determinísticos** (um brief por domínio) e, no fim, transforma JSONs
soltos em um **relatório único**. O LLM caro só é gasto onde importa: julgar o código.

```mermaid
flowchart TD
    A["Agente principal executa o skill /houndsman"]
    A --> B["Houndsman CLI"]
    B --> C["Analisa o diff e os arquivos alterados"]
    C --> D["Classifica os arquivos pelos classify dos watchdogs"]
    D --> JV["Jev — Passo 1.5 (opcional)"]
    JV --> E["Monta briefs determinísticos por watchdog"]
    E --> F["Disponibiliza regras e contextos via CLI"]

    F --> G{"Agente principal despacha subagentes"}
    G --> H["Watchdog Front-end"]
    G --> I["Watchdog Back-end"]
    G --> Q["Watchdog Qualidade de Código"]

    H --> K["Findings Front-end"]
    I --> L["Findings Back-end"]
    Q --> M["Findings Qualidade"]

    K --> N["CLI consolida os findings"]
    L --> N
    M --> N

    N --> O["Agente principal analisa o relatório consolidado"]
    O --> P["Resumo final de violações e problemas"]

    classDef agent fill:#e8def8,stroke:#7952a8,color:#24133d
    classDef cli fill:#dbeafe,stroke:#3973ac,color:#102a43
    classDef result fill:#d1fae5,stroke:#27845b,color:#123b2a
    classDef jev fill:#fef3c7,stroke:#b45309,color:#432004

    class A,G,O agent
    class B,C,D,E,F,N cli
    class JV jev
    class K,L,M,P result
```

**Na ordem em que acontece:**

1. **Skill → CLI.** O agente principal invoca `/houndsman`; o skill chama o binário `houndsman`
   (nada de script manual).
2. **Diff → classificação.** O CLI coleta o diff **uma única vez** (`git diff` + `--numstat`) —
   o custo não cresce com o nº de arquivos —, aplica as exclusions e classifica cada arquivo
   pelo `classify` que cada watchdog declara. Além de `filename`/`content`, regras podem usar
   fatos do **AST** (`symbol`, `import`, `export`, `decorator`) quando a grammar está disponível.
   Cada arquivo ganha também o **churn** (linhas adicionadas/removidas). Arquivo sem dono fica
   `unclassified`.
3. **Briefs determinísticos.** Para cada watchdog ativado, o CLI renderiza um brief com **só**
   os arquivos do domínio dele + **só** as regras daquele domínio. Nunca o diff completo. Os
   arquivos entram **priorizados por churn** e limitados pelo **orçamento** (ver abaixo).
4. **Despacho em ondas.** O agente principal cria **um subagente por brief**, despachados em
   ondas (ex.: até 8 por bloco de chamadas) para não estourar rate limit. Cada watchdog recebe
   apenas o seu contexto — nunca o dos outros.
5. **Findings em JSON.** Cada watchdog grava `findings/<id>.json` com schema fixo
   (`OUTPUT-FORMAT.md`) — markdown livre não consolida.
6. **Consolidação.** `houndsman --finalize` valida os JSONs, deduplica por `(file, line, rule)`
   (watchdogs sobrepostos não geram achado duplicado), agrupa por severidade **e por arquivo** e
   grava um `review.<watchdog>.md` por domínio com achados. Também persiste a triagem no
   storage — cada finding ganha um `id` e um **fingerprint de conteúdo** (a linha é cache,
   não identidade), base da triagem (Passo 4).
7. **Leitura final.** O agente principal lê o `review.md` consolidado e produz o resumo de
   violações e problemas.
8. **Triagem (opcional).** `houndsman server` abre a UI local para marcar cada finding como
   `pending`/`execute`/`ignore` e acompanhar a execução; o agente usa
   `houndsman findings list/set/done/sync` para o auto-fix (as linhas mudam — o motor reancora
   por conteúdo). A sidebar tem abas **Execuções** e **PR's**: a segunda lista as PRs abertas
   via `gh`, faz checkout quando a árvore está limpa e abre a run correspondente. A aba
   **Comentários** carrega, sob demanda, as threads da PR da branch (cache de 60s).

### Orçamento por brief (PRs grandes)

Num PR de milhares de linhas, um único domínio pode concentrar centenas de arquivos — e um brief
com todos eles estouraria o contexto do subagente. O motor corta isso com um **orçamento**: no
máximo `budgets.maxFilesPerBrief` arquivos por brief (default **40**), **os de maior churn**.

- O excedente vira a seção **Fora do orçamento (NÃO revisar)** no brief: o watchdog **não** os
  lê, mas deve registrá-los em `skipped`.
- A tabela de **Cobertura** mostra o que ficou de fora (`faltam N`) — **nada some em silêncio**.
- Opcional no `houndsman.config.ts`:

```ts
budgets: { maxFilesPerBrief: 60 },
concurrency: { jev: 8 },
```

> Em PRs pequenos o orçamento não muda nada (o default de 40 raramente é atingido).

### Onde o Jev entra

O **Jev** é o **Passo 1.5** — roda **dentro do CLI, na mesma etapa do Passo 1 (preparar)**,
**depois** da classificação e **antes** de os subagentes serem despachados. Em outras palavras:
ele *aquece* os briefs antes do despacho.

```mermaid
flowchart LR
    D["Classificação"] --> JV["Jev (Passo 1.5)"]
    JV --> E["Briefs por watchdog"]
```

- **O que faz:** se `HOUNDSMAN_TYPE_SAFE_API_KEY` existir, o Jev avalia cada arquivo contra as regras
  *atômicas* dos watchdogs que o cobrem. Respostas acima do limiar de confiança viram
  **candidatos** (`candidates.json`).
- **O que muda:** os candidatos entram no brief como *warm start* — **não são achados**. O
  subagente **confirma ou refuta**; os não confirmados caem em `🔎 Candidatos não verificados`
  no relatório final.
- **Opcional:** sem chave, erro ou timeout → `available:false` e a revisão roda idêntica. É
  **pré-análise, nunca gate**. Para desligar: `houndsman --no-jev`.

Resumindo o papel de cada um: **o Jev sugere, os watchdogs decidem, o CLI consolida.**

### AST determinístico (TS/JS)

O AST roda **antes** dos briefs e **sem LLM**: `web-tree-sitter` (wasm embarcado) parseia os
arquivos alterados e produz fatos estruturais, delta e impacto. É a camada que dá “inteligência”
barata à classificação e ao contexto.

- **Fatos por arquivo:** símbolos (função/classe/método/interface/tipo/enum/variável), imports,
  exports, decorators e assinaturas.
- **Delta:** compara a versão base com a atual e o patch do arquivo — símbolos adicionados,
  removidos e alterados, mudanças de assinatura, imports e exports.
- **Impacto reverso:** usa `git grep` pelo nome do módulo e confirma o import resolvido
  (relativo ou alias) — devolve quem importa os arquivos alterados e quais exports públicos
  mudaram.
- **Brief:** a seção `Estrutura (AST)` entra no brief como **mapa de leitura**, nunca como
  achado. O watchdog confirma no código.
- **Artefatos:** `ast-summary.json` e `ast-impact.json` ficam no storage para auditoria.
- **Fail-open:** grammar ausente, ABI incompatível, arquivo grande/binário ou erro de git
  desligam o AST naquela run. O regex continua sendo o fallback e `unclassified` continua
  existindo. Desligar: `--no-ast` ou `ast: { enabled: false }`.

Config opcional no `houndsman.config.ts`:

```ts
ast: {
	aliases: { "@/*": "src/*" },
	maxFileBytes: 512_000,
	maxImpactFiles: 200,
},
```

### Review incremental e `verify`

- **Incremental:** cada `--finalize` grava o commit revisado (`reviewedSha` da review).
  O prepare seguinte revisa **só o delta** (arquivos alterados desde então) e **carrega** os
  findings dos arquivos inalterados (carry-over). Sem mudanças → no-op; rebase/force-push → review
  completo. Forçar completo: `houndsman --full`.
- **`findings verify`:** confere se as violações foram resolvidas **sem re-revisar a PR** — tier
  local (reancoragem por conteúdo, grátis) + Jev só nos casos ambíguos (diff focado
  `foundAtSha..HEAD`, uma pergunta por finding). `--apply` marca os `resolved` como `done`;
  o `verify.md` fica no storage e pode ser lido na UI.

### Revisando várias PRs em paralelo (worktrees)

O clone principal pode continuar no seu branch de trabalho enquanto as PRs são revisadas
em worktrees isoladas:

- `houndsman --pr <n>` consulta a PR via `gh`, busca `refs/pull/<n>/head` (funciona em
  forks), cria o worktree **detached** no commit do head e roda o prepare ali.
- `--worktree <path>` usa um worktree já existente (ex.: criado à mão); informe
  `--branch` se ele estiver em detached HEAD.
- A review continua identificada por `(repositório, branch)`; `worktreePath` e
  `prNumber` ficam gravados no storage e são usados por `findings`, `verify` e pela UI
  para ler os arquivos certos.
- `houndsman worktree list|add|remove|prune|path` administra os diretórios em
  `<repo>/.houndsman/worktrees/<repo>/<branch>` (default).
- Duas revisões em branches diferentes usam workspaces distintos e podem rodar ao mesmo
  tempo; o SQLite já opera em WAL e o staging é por `reviewId`.

#### Por que dentro do workspace (e como mudar)

O default `worktrees.location: "workspace"` mantém worktree **e staging**
(`briefs/`, `findings/`, contexto) dentro da pasta aberta no editor. Isso evita que
agentes de codificação peçam permissão a cada leitura/execução fora do workspace. O
diretório é auto-ignorado pelo git.

```ts
// houndsman.config.ts
export default defineHoundsmanConfig({
  // ...
  worktrees: { location: "workspace" }, // default
  // worktrees: { location: "home" },   // <HOUNDSMAN_HOME>/worktrees
  // worktrees: { location: "../wt" },   // caminho relativo à raiz do repo
});
```

Se o agente continuar pedindo permissão, confirme que ele está aberto na raiz do
repositório (não em uma subpasta) e que o caminho do worktree está sob ela.

---

## Comandos do dia a dia

| Comando | Função |
|---|---|
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman update` | Sincroniza os arquivos auto-gerados (`.houndsman/core`) |
| `houndsman doctor` | Valida a configuração, o ambiente e a credencial Jev |
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman --base main` | Passo 1 — prepara os briefs |
| `houndsman --pr <n>` | Prepara a PR em um worktree dedicado |
| `houndsman --worktree <path>` | Prepara em um worktree já existente |
| `houndsman --finalize` | Passo 3 — gera o relatório |
| `houndsman worktree <ação>` | `list`/`add`/`remove`/`prune`/`path` dos worktrees |
| `houndsman watchdog <id>` | Contexto de um watchdog (`--rules`, `--json`) |
| `houndsman findings <sub>` | Triagem/correção dos findings (`list`/`show`/`set`/`done`/`reset`/`sync`/`summary`/`batch`/`verify`/`path`) |
| `houndsman server` | UI local de triagem + leitura de artefatos (`--port`, `--host`, `--open`, `--editor`) |

Flags: `--base <branch>` (default `main`) · `--head <ref>` (default `HEAD`) ·
`--branch <nome>` · `--pr <n>` · `--worktree <path>` · `--config <path>` · `--clean` ·
`--full` · `--no-jev` · `--no-ast` · `--fail-on-blocking` (com `--finalize`) ·
`--editor <auto|vscode|jetbrains|none>` (com `server`).

---

## Escrevendo boas regras

O texto da regra é renderizado **literalmente** no brief do subagente — ambiguidade vira
ruído na revisão. Toda regra começa com um **prefixo de polaridade**:

- `Promover:` → algo que **DEVE** acontecer (o padrão precisa existir no código).
- `Evitar:` → algo que **NÃO DEVE** acontecer. `Não` e `Nunca` no início são equivalentes.

Boas práticas:

1. **Só regra que o projeto aplica hoje** — prove com evidência (`arquivo:linha` para
   afirmativas; `0 ocorrências via grep` do anti-padrão para negativas). Regra afirmativa sem
   aplicação real gera falso positivo.
2. **Geral e reutilizável** — descreva um padrão do domínio, não uma regra de negócio
   amarrada a uma única classe/use-case (isso é papel de teste automatizado).
3. **Condição inequívoca e critério concreto** — duas IAs chegam à mesma conclusão; use
   limite/lista explícita ou símbolo real do código.
4. **Sem jargão vago nem qualificador vazio** — nada de "o antigo", "isso", "apenas por
   compatibilidade".
5. **Declare o `classify`** do watchdog — regex de path (`filename`) ou de conteúdo
   (`content`) para o motor achar os arquivos do domínio.
6. **Prefira editar via `/houndsman train`** — aplica a rubrica completa e roda as
   verificações (`doctor`, `test`).

> `houndsman doctor` emite um aviso (não bloqueante) para regra sem prefixo de polaridade.

Exemplo:

```ts
{ severity: "blocking",  text: "Evitar: handler de webhook processa o payload antes de validar a assinatura do provider." }
{ severity: "attention", text: "Promover: rotas validam a entrada com o schema do domínio." }
```

---

## Estrutura gerada por `setup`

```
houndsman.config.ts
.houndsman/
├── .gitignore            # AUTO
├── core/                 # AUTO — sincronizado por `update`
│   ├── types.ts
│   └── skill/*.md
├── watchdogs/            # você — 1 módulo .ts por watchdog
│   └── index.ts
├── exclusions.ts         # você
└── doc-mappings.ts       # você
```

Cada review, seus findings e artefatos ficam no **storage global** — SQLite em
`<HOUNDSMAN_HOME>/houndsman.db` (default), com `storage.provider: "file"` como fallback.
O staging dos subagentes (`briefs/`, `findings/`, contexto) fica em
`<HOUNDSMAN_HOME>/work/<reviewId>/` e é limpo após o `--finalize`. Nada é gravado em
`.houndsman/.runs`.
