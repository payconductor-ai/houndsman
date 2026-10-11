# Atualização de Lógicas do houndsman

> **Documento canônico do skill `/update-houndsman`.** Os `SKILL.md` de cada harness
> (`.agents/skills/update-houndsman/` e `.claude/skills/update-houndsman/`) são apenas ponteiros para cá.

> **Propósito:** manter os revisores do skill `houndsman` alinhados ao que o
> projeto **realmente aplica** — seja para adicionar/ajustar uma regra a pedido do
> usuário, seja para uma auditoria geral após mudanças de padrão no código.

Este skill é o **mantenedor** do `houndsman`. Ele não revisa PRs; ele atualiza as regras
que o `houndsman` usa.

---

## Princípio Fundamental (Regra de Ouro)

> Só é regra o que o projeto **aplica hoje**. A **ausência** de um padrão no código é
> evidência de que ele **não é aplicado** — não inferir intenção aspiracional.

Toda regra nova ou alterada deve vir com **evidência** (arquivo:linha ou "0 ocorrências
via grep X"). Regra sem evidência é rejeitada ou vira `suggestion` explicitamente
aprovada pelo usuário.

Ver `AUDIT-PROTOCOL.md` para a taxonomia completa.

---

## Quando Usar

- Usuário pede para **adicionar / alterar / remover** uma regra de revisão.
- Um revisor está gerando **falso positivo** (cobra padrão não aplicado).
- O projeto mudou de padrão (ex.: passou a usar uma lib, mudou autenticação, etc.).
- **Auditoria completa** dos revisores após revisão geral do código.
- **Regra confusa/ambígua** (humano ou IA não entende) — ver Modo C.
- O usuário invoca `/update-houndsman`.

---

## Arquivos que definem a revisão

> A primeira parte é a **camada de projeto** (muda por consumidor); a segunda é o **motor**
> (o pacote `houndsman`).

| Arquivo | Papel |
|---|---|
| `.houndsman/reviewers/<id>.ts` | **Fonte de verdade**: `defineReviewer` com `rules` (severidade + texto), `scope`, `description`, `reviewFocus`, `exclude`, `breakingChange`, `contextFiles`, `classify` |
| `.houndsman/reviewers/index.ts` | `REVIEWER_DEFINITIONS` — as **chaves definem os ids** (`ReviewerId`); `reviewerIds` é derivado |
| `houndsman.config.ts` | `reviewConfig` do projeto — `projectName`, `artifactDir`, `reviewers`, `exclusions`, `docMappings` (descoberto em runtime) |
| `.houndsman/exclusions.ts` | `EXCLUSION_PATTERNS` + `isExcluded` |
| `.houndsman/doc-mappings.ts` | `DOC_MAPPINGS` (path → docs) |
| `.houndsman/core/types.ts` | Snapshot gerado dos tipos + helpers (autocontido) |
| `src/core/types.ts` | Tipos genéricos: `Severity`, `Rule`, `ReviewerDefinition`, `defineReviewer` |
| `src/core/config.ts` | `ReviewConfig<TId>` + `defineReviewConfig` (contrato do motor) |
| `src/core/config-loader.ts` | Descoberta/carregamento de `houndsman.config.ts` |
| `src/core/brief.ts` | Render do brief: `defaultRenderBrief` + `PROCEDURE` |
| `src/core/registry-check.ts` | Validação anti-drift (config-driven) |
| `src/skill/houndsman.md` | Orquestração + tabela de revisores |
| `src/tests/**` | Suíte da lib (project-agnóstica; usa `fixtures/fake-project.ts`) |
| `src/cli/index.ts` | **CLI único** — `houndsman [context, setup, doctor, test, reviewer, --finalize]` |

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

## Modo A — Ajuste pontual (pedido do usuário)

1. **Interpretar o pedido** — extrair: qual regra, qual revisor, adicionar/alterar/remover.
2. **Identificar o revisor** pelos paths de `classify` da camada de projeto. Em dúvida, perguntar.
3. **Provar no código** (Regra de Ouro):
   - `grep_search` pelo padrão real e pelo anti-padrão.
   - Determinar se a regra é `ALIGNED`, `UTOPIAN`, `OUTDATED`, `MISCALIBRATED` ou `DEAD-PATH`.
   - Coletar `file:line` como evidência.
4. **Editar `.houndsman/reviewers/<id>.ts`** (`REVIEWER_DEFINITIONS[<id>]`):
   - `rules`: uma entrada `{ severity, text }` por regra (o que verificar/evitar é implícito no texto).
   - Ajustar `scope` / `description` / `reviewFocus` / `exclude` / `contextFiles` se necessário.
   - Se a regra muda para outro domínio (paths), ajustar o `classify` do revisor.
5. **Revisor novo?** criar `.houndsman/reviewers/<id>.ts` e registrar em `.houndsman/reviewers/index.ts` (o id é derivado das chaves).
6. **Atualizar `src/skill/houndsman.md`/`README.md`** se escopo/regra visível mudou (no motor).
7. **Atualizar a suíte da lib** se o comportamento do MOTOR mudou (a suíte é project-agnóstica).
8. **Verificar** (seção abaixo).

---

## Modo B — Auditoria completa (revisão geral do código)

Para alinhar **todos** os revisores de uma vez.

1. **Fase 0 — Preparação.** Criar `.houndsman-audit/<slug>/` e copiar/adequar `AUDIT-PROTOCOL.md`.
2. **Fase 1 — Auditoria por revisor (subagentes, 1 por revisor, em ondas paralelas).**
   Cada subagente recebe: `REVIEWER_DEFINITIONS[<id>]` + `src/core/brief.ts` (`PROCEDURE`) +
   fontes ground-truth do projeto (ex.: `AGENTS.md`, docs de arquitetura) + código real.
   Saída: `<slug>/<id>.md` com ground-truth do domínio + tabela regra × veredito × evidência × ação.
3. **Fase 2 — Consolidação.** Merge em `audit-summary.md`; agrupar temas transversais; resolver
   regras duplicadas entre revisores.
4. **Fase 3 — Alinhamento com o usuário.** Apresentar remoções/correções borderline e obter
   aprovação **antes** de editar (regra utópica → remover; parcial → `suggestion`).
5. **Fase 4 — Aplicar.** Editar `.houndsman/reviewers/*.ts` + `.houndsman/**` + `src/skill/**` + testes.
6. **Fase 5 — Verificar** (seção abaixo).

> Detalhes de taxonomia, formato de relatório e evidência: `AUDIT-PROTOCOL.md`.

---

## Modo C — Revisão de clareza das regras

Alinha o **texto** das regras (não a semântica) para que humano e IA interpretem igual.
As regras são renderizadas **literalmente** nos briefs dos subagentes (`renderBrief` em
`src/core/brief.ts`) — o texto da regra é exatamente o que a IA lê.

### Rubrica de clareza (toda regra deve passar)

1. **Sujeito explícito** — diz qual artefato é verificado; sem pronome órfão ("o antigo", "isso").
2. **Condição inequívoca** — duas IAs chegam à mesma conclusão sobre o que é violação.
3. **Critério concreto** — limite/prazo/lista explícito ou referência a símbolo real do código.
4. **Jargão definido** — sigla/termo técnico definido ou ancorado num símbolo existente.
5. **Sem qualificador vago** — proibido: "apenas por compatibilidade", "período de depreciação", "conjunto real", "completos e corretos", "só faz sentido", "indefinidamente".
6. **Voz consistente** — imperativa/verificável ("NUNCA…", "usar…", "validar…").
7. **Escopo coerente** — a regra pertence ao domínio do revisor.
8. **Sem duplicata** — nenhuma regra repetida literalmente no mesmo revisor.

### Passos

1. Inventariar todas as regras (`rules`) dos revisores alvo.
2. Marcar cada regra contra a rubrica; propor reescrita **preservando semântica e severidade**.
3. Se a regra também for ambígua **e não houver evidência de aplicação** no código, tratá-la como
   `UTOPIAN`/`OUTDATED` (remover/rebaixar) conforme a Regra de Ouro.
4. Aplicar em `.houndsman/reviewers/<id>.ts`; corrigir duplicatas/sobreposições.
5. Se o termo citado for do procedimento, ajustar `PROCEDURE`/`reviewFocus`/`exclude` em
   `src/core/brief.ts` ou no revisor.
6. Conferir que o `renderBrief` continua renderizando o texto da regra (dry-run abaixo).
7. Verificar (seção abaixo).

---

## Verificação (obrigatória)

```bash
bun run houndsman doctor     # config sem drift + ambiente
bun run houndsman test       # suíte da lib (project-agnóstica)
bun run ci:fix               # formatação/imports/lint (no repo da lib)
bun run ci:check             # tipagem (no repo da lib)
```

Checklist final:

- [ ] `bun run houndsman doctor` → sem problemas reportados.
- [ ] `bun run houndsman test` → **0 fail**.
- [ ] `ci:fix` + `ci:check` → exit 0 (warnings pré-existentes não contam).
- [ ] `REVIEWER_DEFINITIONS[<id>].id` bate com a chave e `description` não vazio.
- [ ] `src/skill/houndsman.md` continua consistente com os revisores do projeto.
- [ ] Toda regra nova/alterada tem **evidência** registrada no PR/relatório.
- [ ] Brief de amostra não contém regra removida (dry-run abaixo).
- [ ] Nenhuma regra contém qualificador vago (rubrica do Modo C) — conferir via grep.

```bash
# Dry-run: gerar briefs e conferir ausência de regras removidas
bun -e "import { renderBrief } from 'houndsman'; import { REVIEWER_DEFINITIONS } from './.houndsman/reviewers'; const base={files:['x.ts'],branch:'t',outputPath:'o.json',docs:[],statuses:{},deleted:[]}; for (const id of Object.keys(REVIEWER_DEFINITIONS)) console.log(id, /verifySignature|circuit|saldo/i.test(renderBrief(REVIEWER_DEFINITIONS[id],{...base,reviewerId:id})) ? 'FOUND' : 'OK');"
```
