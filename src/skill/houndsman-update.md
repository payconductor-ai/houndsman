# Atualização de Lógicas do houndsman

> **Documento canônico do skill `/houndsman-update`.** Os `SKILL.md` de cada harness
> (`.agents/skills/houndsman-update/` e `.claude/skills/houndsman-update/`) são apenas ponteiros para cá.

> **Propósito:** manter os watchdogs do skill `houndsman` alinhados ao que o
> projeto **realmente aplica** — seja para adicionar/ajustar uma regra a pedido do
> usuário, seja para uma auditoria geral após mudanças de padrão no código.

Este skill é o **mantenedor** do `houndsman`. Ele não revisa PRs; ele atualiza as regras
que o `houndsman` usa.

---

## Princípio Fundamental (Regra de Ouro)

> Só é regra o que o projeto **aplica hoje**. Como provar depende da **polaridade** da regra
> (ver Convenções de escrita, abaixo):
>
> - Regra **afirmativa** (`Promover:`): exige a **presença** de um padrão. Ele deve existir no
>   código; se não existe em lugar nenhum, é `UTOPIAN` (remover/rebaixar).
> - Regra **negativa** (`Evitar:`, `Não`, `Nunca`): exige a **ausência** de um anti-padrão.
>   **Zero ocorrências = regra seguida** → **manter**. Nunca remover uma regra negativa só
>   porque não há ocorrências.

Toda regra nova ou alterada deve vir com **evidência**: `arquivo:linha` (regra afirmativa) ou
`0 ocorrências via grep X` do anti-padrão (regra negativa). Regra sem evidência é rejeitada ou
vira `suggestion` explicitamente aprovada pelo usuário.

Ver `AUDIT-PROTOCOL.md` para a taxonomia completa.

---

## Convenções de escrita das regras

Rubrica única — o texto da regra é renderizado **literalmente** no brief do subagente
(`renderBrief` em `src/core/brief.ts`), então toda ambiguidade vira ruído na revisão.
Toda regra (nova ou alterada) deve passar por **todos** os itens:

> **Prefixo de polaridade (obrigatório).** Toda regra começa com o sentido do que se espera:
> `Promover:` → algo que **DEVE** acontecer (a presença do padrão); `Evitar:` → algo que
> **NÃO DEVE** acontecer (a ausência do anti-padrão); `Não` e `Nunca` no início são
> equivalentes aceitos de `Evitar:`. Regra sem prefixo explícito é ambígua e o
> `houndsman doctor` emite um aviso. O prefixo define **um único sentido** por regra —
> ver *Unipolar* (item 8).

1. **Sujeito explícito** — diz qual artefato é verificado; sem pronome órfão ("o antigo", "isso").
2. **Condição inequívoca** — duas IAs chegam à mesma conclusão sobre o que é violação.
3. **Critério concreto** — limite/prazo/lista explícito ou referência a símbolo real do código.
4. **Geral e reutilizável** — descreve um padrão do **domínio**, não uma regra de negócio pontual
   que só existe dentro de uma classe/use-case. Regra amarrada a um único ponto do código não é
   replicável em outros contextos — isso é papel de **teste automatizado**, não do watchdog.
   - ❌ `Promover: cálculo de taxa deve usar toDecimals` (o cálculo de taxa vive atrás de um único
     use-case — a regra não se aplica em nenhum outro contexto).
5. **Sem jargão abreviado ou vago** — sigla/termo/apelido deve estar definido ou ancorado num
   símbolo/path real do código; nunca um apelido interno sem referência.
   - ❌ `Evitar que o flow faça parte do grupo` (não se sabe o que é "flow" nem "grupo").
6. **Sem qualificador vago** — proibido: "apenas por compatibilidade", "período de depreciação",
   "conjunto real", "completos e corretos", "só faz sentido", "indefinidamente".
7. **Polaridade explícita** — a regra começa com o sentido inequívoco:
   - `Promover:` → algo que **DEVE** acontecer (ex.: `Promover: rotas validam a entrada com o schema do Elysia`).
   - `Evitar:` → algo que **NÃO DEVE** acontecer; `Não` / `Nunca` no início são **equivalentes aceitos** de `Evitar:`.
8. **Unipolar (um só sentido)** — a regra expressa **uma única direção**, a mesma do prefixo:
   só afirmações de **promover** ou só afirmações de **evitar**. Não combine "faça X" **e**
   "não faça Y" na mesma regra — são dois juízos independentes, com veredito e evidência
   próprios. Regra que precisa dos dois sentidos **vira duas regras**: uma `Promover:` e
   outra `Evitar:`.
   - ❌ `Evitar: o handler valida a entrada e não acessa o banco direto` (afirmação + negação).
   - ✅ `Promover: o handler valida a entrada com o schema do Elysia` **+**
     `Evitar: o handler acessa o banco direto`.
   - Exceção **aceitável**: quando os dois sentidos são **inseparáveis** (a negação é condição
     direta da afirmação). Aí o prefixo lidera o sentido dominante e o outro entra como oração
     subordinada — nunca como segundo juízo coordenado.
9. **Escopo coerente** — a regra pertence ao domínio do watchdog.
10. **Sem duplicata** — nenhuma regra repetida literalmente no mesmo watchdog.

> O `houndsman doctor` emite um **aviso** (não bloqueante) para regra sem polaridade explícita
> (`Promover:`, `Evitar:`, `Não` ou `Nunca`).

---

## Quando Usar

- Usuário pede para **adicionar / alterar / remover** uma regra de revisão.
- Um watchdog está gerando **falso positivo** (cobra padrão não aplicado).
- O projeto mudou de padrão (ex.: passou a usar uma lib, mudou autenticação, etc.).
- **Auditoria completa** dos watchdogs após revisão geral do código.
- **Regra confusa/ambígua** (humano ou IA não entende) — ver Modo C.
- O usuário invoca `/houndsman-update`.

---

## Arquivos que definem a revisão

> A primeira parte é a **camada de projeto** (muda por consumidor); a segunda é o **motor**
> (o pacote `@payconductor/houndsman`).

| Arquivo | Papel |
|---|---|
| `.houndsman/watchdogs/<id>.ts` | **Fonte de verdade**: `defineWatchdog` com `rules` (severidade + texto), `scope`, `description`, `reviewFocus`, `exclude`, `breakingChange`, `contextFiles`, `classify` |
| `.houndsman/watchdogs/index.ts` | `WATCHDOG_DEFINITIONS` — as **chaves definem os ids** (`WatchdogId`); `watchdogIds` é derivado |
| `houndsman.config.ts` | `houndsmanConfig` do projeto — `projectName`, `artifactDir`, `watchdogs`, `exclusions`, `docMappings` (descoberto em runtime) |
| `.houndsman/exclusions.ts` | `EXCLUSION_PATTERNS` + `isExcluded` |
| `.houndsman/doc-mappings.ts` | `DOC_MAPPINGS` (path → docs) |
| `.houndsman/core/types.ts` | Snapshot gerado dos tipos + helpers (autocontido) |
| `src/core/types.ts` | Tipos genéricos: `Severity`, `Rule`, `WatchdogDefinition`, `defineWatchdog` |
| `src/core/config.ts` | `HoundsmanConfig<TId>` + `defineHoundsmanConfig` (contrato do motor) |
| `src/core/config-loader.ts` | Descoberta/carregamento de `houndsman.config.ts` |
| `src/core/brief.ts` | Render do brief: `defaultRenderBrief` + `PROCEDURE` |
| `src/core/registry-check.ts` | Validação anti-drift (config-driven) |
| `src/skill/houndsman.md` | Orquestração + tabela de watchdogs |
| `src/tests/**` | Suíte da lib (project-agnóstica; usa `fixtures/fake-project.ts`) |
| `src/cli/index.ts` | **CLI único** — `houndsman [context, setup, doctor, test, watchdog, --finalize]` |

> Todo o markdown canônico vive em `src/skill/` (fonte única). Os `SKILL.md` de cada harness
> são apenas ponteiros — não duplicar conteúdo.

---

## Severidade

| Severidade | Quando usar |
|---|---|
| `blocking` | Violação que quebra contrato, segurança ou integridade — e o projeto **já faz** do jeito certo em todos os lugares |
| `attention` | Boa prática aplicada na maior parte do código, com exceções aceitáveis |
| `suggestion` | Recomendação aplicada parcialmente; nunca bloqueia |
| `nit` | Detalhe cosmético/observação; ruído, nunca bloqueia |

> Severidade não é aspiração: se o projeto só aplica o padrão em 15/72 lugares, é `suggestion`.

---

## Pré-análise Jev (opcional)

Regra que deve ser verificada automaticamente antes da revisão declara `jev`. É sempre um
**objeto** com `kind` obrigatório — a presença de `jev` não é um liga/desliga do Jev:

| Campo | Obrigatório | Uso |
|---|---|---|
| `kind` | ✅ | `noul` (a violação ocorre?), `choice` (opções) ou `score` (rubrica) |
| `instructions` | — | Pergunta customizada; omitida, é derivada do texto da regra |
| `criteria` | em `choice`/`score` | Objeto `{ valor: rótulo }` para `choice`; lista de rótulos para `score` |

```ts
{ severity: "blocking", text: "Import de TypeBox direto", jev: { kind: "noul" } }
{ severity: "attention", text: "Repository com lógica", jev: { kind: "noul", instructions: "O repository tem lógica de negócio?" } }
```

Não anotar todas as regras: o Jev custa uma chamada por arquivo. Reservar para as regras
verificáveis por leitura local. Candidatos não confirmados pelo watchdog **não bloqueiam**.

---

## Modo A — Ajuste pontual (pedido do usuário)

1. **Interpretar o pedido** — extrair: qual regra, qual watchdog, adicionar/alterar/remover.
2. **Identificar o watchdog** pelos paths de `classify` da camada de projeto. Em dúvida, perguntar.
3. **Provar no código** (Regra de Ouro):
   - `grep_search` pelo padrão real e pelo anti-padrão.
   - Determinar a **polaridade**: afirmativa (`Promover:` → exige presença; ausência = `UTOPIAN`) ou
     negativa (`Evitar:`/`Não`/`Nunca` → exige ausência; **0 ocorrências do anti-padrão = `ALIGNED`**).
   - Classificar: `ALIGNED`, `UTOPIAN`, `OUTDATED`, `MISCALIBRATED` ou `DEAD-PATH`.
   - Coletar a evidência (`file:line` afirmativa; `0 ocorrências via grep X` negativa).
4. **Editar `.houndsman/watchdogs/<id>.ts`** (`WATCHDOG_DEFINITIONS[<id>]`):
   - `rules`: uma entrada `{ severity, text }` por regra — o texto começa com `Promover:` (DEVE) ou
     `Evitar:`/`Não`/`Nunca` (NÃO DEVE), conforme as Convenções de escrita.
   - Regra que mistura afirmação e negação (dois sentidos) → dividir em **duas entradas** (*Unipolar*, item 8).
   - `jev` (opcional): `{ kind: "noul" }`, com `instructions` e/ou `criteria` — ver seção acima.
   - Ajustar `scope` / `description` / `reviewFocus` / `exclude` / `contextFiles` se necessário.
   - Se a regra muda para outro domínio (paths), ajustar o `classify` do watchdog.
5. **Watchdog novo?** criar `.houndsman/watchdogs/<id>.ts` e registrar em `.houndsman/watchdogs/index.ts` (o id é derivado das chaves).
6. **Atualizar `src/skill/houndsman.md`/`README.md`** se escopo/regra visível mudou (no motor).
7. **Atualizar a suíte da lib** se o comportamento do MOTOR mudou (a suíte é project-agnóstica).
8. **Verificar** (seção abaixo).

---

## Modo B — Auditoria completa (revisão geral do código)

Para alinhar **todos** os watchdogs de uma vez.

1. **Fase 0 — Preparação.** Criar `.houndsman-audit/<slug>/` e copiar/adequar `AUDIT-PROTOCOL.md`.
2. **Fase 1 — Auditoria por watchdog (subagentes, 1 por watchdog, em ondas paralelas).**
   Cada subagente recebe: `WATCHDOG_DEFINITIONS[<id>]` + `src/core/brief.ts` (`PROCEDURE`) +
   fontes ground-truth do projeto (ex.: `AGENTS.md`, docs de arquitetura) + código real.
   Saída: `<slug>/<id>.md` com ground-truth do domínio + tabela regra × veredito × evidência × ação.
3. **Fase 2 — Consolidação.** Merge em `audit-summary.md`; agrupar temas transversais; resolver
   regras duplicadas entre watchdogs.
4. **Fase 3 — Alinhamento com o usuário.** Apresentar remoções/correções borderline e obter
   aprovação **antes** de editar (regra utópica → remover; parcial → `suggestion`).
5. **Fase 4 — Aplicar.** Editar `.houndsman/watchdogs/*.ts` + `.houndsman/**` + `src/skill/**` + testes.
6. **Fase 5 — Verificar** (seção abaixo).

> Detalhes de taxonomia, formato de relatório e evidência: `AUDIT-PROTOCOL.md`.

---

## Modo C — Revisão de clareza das regras

Alinha o **texto** das regras (não a semântica) para que humano e IA interpretem igual.
As regras são renderizadas **literalmente** nos briefs dos subagentes (`renderBrief` em
`src/core/brief.ts`) — o texto da regra é exatamente o que a IA lê.

A rubrica é a seção **Convenções de escrita das regras** (acima). Toda regra deve passar por
todos os itens — em especial: **geral/reutilizável** (não regra de negócio pontual),
**sem jargão abreviado**, **polaridade explícita** (`Promover:` / `Evitar:`/`Não`/`Nunca`) e
**unipolar** (um só sentido por regra — sem afirmar e negar no mesmo texto).

### Passos

1. Inventariar todas as regras (`rules`) dos watchdogs alvo.
2. Marcar cada regra contra a rubrica; propor reescrita **preservando semântica e severidade**.
   Regra que mistura os dois sentidos → **dividir** em afirmativa e negativa (*Unipolar*, item 8).
3. Se for regra **afirmativa** ambígua **e não houver evidência de aplicação** no código,
   tratá-la como `UTOPIAN`/`OUTDATED` (remover/rebaixar) conforme a Regra de Ouro.
   Para regra **negativa**, a ausência de ocorrências é o **esperado** — não remover por isso.
4. Aplicar em `.houndsman/watchdogs/<id>.ts`; corrigir duplicatas/sobreposições.
5. Se o termo citado for do procedimento, ajustar `PROCEDURE`/`reviewFocus`/`exclude` em
   `src/core/brief.ts` ou no watchdog.
6. Conferir que o `renderBrief` continua renderizando o texto da regra (dry-run abaixo).
7. Verificar (seção abaixo).

---

## Verificação (obrigatória)

```bash
bun run houndsman doctor     # config sem drift + ambiente + credencial Jev
bun run houndsman test       # suíte da lib (project-agnóstica)
bun run ci:fix               # formatação/imports/lint (no repo da lib)
bun run ci:check             # tipagem (no repo da lib)
```

Checklist final:

- [ ] `bun run houndsman doctor` → sem problemas reportados.
- [ ] `bun run houndsman test` → **0 fail**.
- [ ] `ci:fix` + `ci:check` → exit 0 (warnings pré-existentes não contam).
- [ ] `WATCHDOG_DEFINITIONS[<id>].id` bate com a chave e `description` não vazio.
- [ ] `src/skill/houndsman.md` continua consistente com os watchdogs do projeto.
- [ ] Toda regra nova/alterada tem **evidência** registrada no PR/relatório
      (`file:line` se afirmativa; `0 ocorrências do anti-padrão` se negativa).
- [ ] Nenhuma regra **negativa** foi removida por "0 ocorrências" (Regra de Ouro).
- [ ] Brief de amostra não contém regra removida (dry-run abaixo).
- [ ] Toda regra passa nas convenções de escrita (geral/reutilizável, sem jargão abreviado,
      sem qualificador vago, com polaridade explícita e **unipolar**) — conferir via grep.

```bash
# Dry-run: gerar briefs e conferir ausência de regras removidas
bun -e "import { renderBrief } from 'houndsman'; import { WATCHDOG_DEFINITIONS } from './.houndsman/watchdogs'; const base={files:['x.ts'],branch:'t',outputPath:'o.json',docs:[],statuses:{},deleted:[]}; for (const id of Object.keys(WATCHDOG_DEFINITIONS)) console.log(id, /verifySignature|circuit|saldo/i.test(renderBrief(WATCHDOG_DEFINITIONS[id],{...base,watchdogId:id})) ? 'FOUND' : 'OK');"
```
