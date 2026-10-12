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
**Jev** = pré-análise opcional.

---

## Como iniciar

Você monta o **seu time de cães de caça** (os watchdogs), cada um farejando um domínio
diferente das PRs. O motor só coordena a caçada — as regras são problema seu.

### 1. Pré-requisitos

- **Bun** — runtime obrigatório.
- **git** — o diff usa `git diff <base>...<head>`.
- Opcionais, ambos **falha-aberto**: **`gh`** (contexto da PR) e **`TYPESAFE_API_KEY`**
  (pré-análise Jev). Sem eles, a revisão roda igual.

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
| `.houndsman/watchdogs/` | você | Suas regras — começa com **1 watchdog de exemplo** |
| `.houndsman/exclusions.ts` | você | Arquivos que nunca entram na revisão |
| `.houndsman/doc-mappings.ts` | você | path → documentação de contexto |
| `.houndsman/core/**` | auto | Tipos + docs do skill (sincronizados por `houndsman update`) |
| `.agents/` · `.claude/` | auto | Ponteiros de skill dos harnesses |
| `package.json` | — | Adiciona o script `"houndsman"` |

> **Não existe "modo completo".** O `setup` já cria a camada inicial com um watchdog de
> exemplo — troque o exemplo pelas regras reais do seu projeto (ou use `/houndsman-update`).

### 4. Escreva suas regras

Edite `.houndsman/watchdogs/` — veja [Escrevendo boas regras](#escrevendo-boas-regras).

### 5. Valide

```bash
bun run houndsman doctor
```

### 6. Rode a primeira revisão

No seu harness (Claude Code / agents), invoque o skill:

```
/houndsman
```

O skill orquestra tudo e grava o relatório em `.houndsman/.runs/<branch-slug>/review.md`.
Não precisa rodar nenhum script à mão.

---

## O fluxo de trabalho

```
/houndsman
   ├─ Passo 0  contexto da PR (gh, opcional)
   ├─ Passo 1  classifica o diff → briefs por watchdog
   ├─ Passo 2  N subagentes revisam em paralelo
   └─ Passo 3  consolida em review.md
```

- Revisão normal: só `/houndsman` (a branch é detectada; base default `main`).
- Revisar outra branch: `/houndsman feature/minha-branch`.
- Manual (sem skill): `houndsman context` → `houndsman --base main` → *(subagentes)* →
  `houndsman --finalize`.
- CI: `houndsman --finalize --fail-on-blocking` (exit 1 se houver bloqueantes).

---

## Mantendo a configuração

- **Alterar regras** → use o skill **`/houndsman-update`**. Ele prova no código que o padrão
  existe (evidência) antes de editar e roda as validações.
- **Atualizou a lib?** Sincronize os arquivos auto-gerados sem tocar nas suas regras:

  ```bash
  bun run houndsman update
  bun run houndsman doctor
  ```

  O `update` reescreve **só** `.houndsman/core/**` e `.houndsman/.gitignore`. Seus arquivos
  (`watchdogs/`, `exclusions.ts`, `doc-mappings.ts`, `houndsman.config.ts`) nunca são tocados.
- **Recomeçar a camada do zero** → `houndsman setup --force` (sobrescreve só os arquivos do
  usuário; sem `--force` o `setup` é idempotente).

---

## Avançado

### Comandos do dia a dia

| Comando | Função |
|---|---|
| `houndsman setup` | Cria a configuração inicial do projeto |
| `houndsman update` | Sincroniza os arquivos auto-gerados (`.houndsman/core`) |
| `houndsman doctor` | Valida a configuração e o ambiente (anti-drift) |
| `houndsman context` | Passo 0 — contexto da PR via `gh` |
| `houndsman --base main` | Passo 1 — prepara os briefs |
| `houndsman --finalize` | Passo 3 — gera o relatório |
| `houndsman watchdog <id>` | Contexto de um watchdog (`--rules`, `--json`) |

Flags: `--base <branch>` (default `main`) · `--head <ref>` (default `HEAD`) ·
`--branch <nome>` · `--dir <dir>` · `--config <path>` · `--clean` · `--no-jev` ·
`--fail-on-blocking` (com `--finalize`).

### Escrevendo boas regras

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
6. **Prefira editar via `/houndsman-update`** — ele aplica a rubrica completa e roda as
   verificações (`doctor`, `test`).

> `houndsman doctor` emite um aviso (não bloqueante) para regra sem prefixo de polaridade.

Exemplo:

```ts
{ severity: "blocking",  text: "Evitar: handler de webhook processa o payload antes de validar a assinatura do provider." }
{ severity: "attention", text: "Promover: rotas validam a entrada com o schema do domínio." }
```

### Estrutura gerada por `setup`

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

Os artefatos de cada review ficam em `.houndsman/.runs/<branch-slug>/` (auto-ignorados).

---

## Documentação

- **`docs/CONTRIBUTING.md`** — arquitetura, fluxos internos, princípios e desenvolvimento da
  lib (para quem vai contribuir).
- `src/skill/SETUP.md` — referência de configuração passo a passo.
- `src/skill/houndsman.md` — orquestração do skill `/houndsman`.
- `src/skill/houndsman-update.md` — manutenção das regras dos watchdogs.
