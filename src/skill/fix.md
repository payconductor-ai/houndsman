# houndsman — {{projectName}} · `fix` (correção dos findings)

> **Documento canônico da capability `fix`.** O entry point do skill é o `SKILL.md`
> (`.agents/skills/houndsman/SKILL.md` e `.claude/skills/houndsman/SKILL.md`).

Corrige os achados de uma revisão **já finalizada** (`hunt`): lê a triagem, aplica as
correções marcadas e mantém o estado de triagem em dia — **sem editar o `state.json` à mão**.

Invocação: `/houndsman fix`. Não revisa nem altera regras; consome o que o `hunt` produziu.

**Quando usar:**

- Depois de `/houndsman` (ou `houndsman --finalize`), para corrigir os achados.
- O usuário marcou achados como `execute` (na UI local ou via `findings set`).
- "Corrija os findings", "aplica as correções", "resolve os bloqueantes".

> **Pré-requisito:** existe `.houndsman/.runs/<branch-slug>/state.json` da run atual
> (gerado no `--finalize`). Se não existir, a revisão não foi finalizada — rode o `hunt` antes.

---

## Modelo de triagem

Cada finding tem duas dimensões independentes (ver `findings-state.ts`):

- **decision:** `pending` · `execute` · `ignore` (+ `comment` opcional).
- **execState:** `pending` · `in_progress` · `done` · `stale`.

`fix` atua **somente** sobre `decision: execute`. Achados `pending` (ainda não triados) e
`ignore` (descartados) ficam intocados — não "conserte" o que o usuário não pediu.

> **A linha de um finding não é a identidade.** A identidade é o **fingerprint** de conteúdo
> (arquivo + regra + âncora). As correções deslocam linhas; o motor reancora pelo conteúdo.
> Ocorrências byte-idênticas (mesmo trecho E mesmo contexto) compartilham o id — tratadas
> como um grupo (`×N`); corrigir uma resolve o grupo.

---

## Procedimento

### 1. Levantar os alvos

```bash
bun run houndsman findings summary --json
bun run houndsman findings list --decision execute --json
```

Comece pelos de maior severidade (`blocking` > `attention` > `suggestion` > `nit`). Para
entender um achado específico: `bun run houndsman findings show <id> --json` (traz `rule`,
`severity`, `file`, `line`, `message`, `action`, `evidence`).

### 2. Marcar em andamento

```bash
bun run houndsman findings set <id> --exec in_progress
```

Sinaliza a intenção antes de editar — evita que outra sessão pegue o mesmo achado.

### 3. Aplicar a correção

Para cada finding: abra o arquivo, leia o trecho ancorado (`line` é cache; confirme pelo
conteúdo) e aplique a **correção mínima** que satisfaz a `rule`, seguindo a **`action`** e a
`evidence` do achado. Respeite o padrão que o watchdog cobra — não introduza um novo
anti-padrão para "calar" o finding. Se a correção exigir decisão de produto/arquitetura,
pare e devolva ao usuário em vez de improvisar.

### 4. Reancorar o estado

```bash
bun run houndsman findings sync
```

Depois de editar, as linhas mudaram. O `sync` reancora cada finding por **conteúdo**
(trecho + contexto) e reporta `ok` / `moved` / `stale`:

- Âncora ainda presente (talvez em outra linha) → marcado `ok`/`moved`.
- Âncora desapareceu (o trecho foi corrigido) **e** a decisão era `execute` → vira `done`
  automaticamente.
- Âncora desapareceu em outro caso → vira `stale` (revisar manualmente).

### 5. Confirmar os concluídos

```bash
bun run houndsman findings done <id...>
```

Marque explicitamente o que você corrigiu (o `sync` já marca vários, mas confirme os seus).

### 6. Tratar o que não deu para corrigir

Não deixe achado `execute` "no limbo". Se não foi possível corrigir, devolva à triagem:

```bash
bun run houndsman findings set <id> --decision pending --comment "<motivo / o que falta>"
```

Use `--decision ignore` (+ `--comment`) só quando o achado for aceito como não-aplicável.

---

## Verificação

- `bun run houndsman findings summary` → os corrigidos saíram de `execute`/`in_progress`.
- `bun run houndsman findings sync` → sem `stale` inesperado.
- Rode o build/testes do **projeto consumidor** (não o houndsman) depois das correções.
- Se a mudança for grande, reexecute o `hunt` para uma segunda passada:

  ```bash
  bun run houndsman --base main
  # ... subagentes ...
  bun run houndsman --finalize
  ```

  > O `--finalize` preserva os ids/fingerprints entre execuções (reancoragem por conteúdo);
  > use `--clean` só quando quiser descartar a triagem anterior.

---

## Anti-padrões

- ❌ Editar `.houndsman/.runs/<slug>/state.json` à mão — use os comandos `findings`.
- ❌ Corrigir findings `pending` ou `ignore` sem o usuário marcar `execute`.
- ❌ Chavear por `(file, line)` — a confiança é o **fingerprint** de conteúdo.
- ❌ Correção cosmética para "sumir" com o finding sem atender a `rule`.
- ❌ Reescrever o arquivo inteiro — correção mínima e localizada.
- ❌ Inventar mudança de produto/arquitetura para fechar um achado ambíguo.
- ❌ Marcar `done` sem ter aplicado a correção (o `sync` reancora; o achado volta).
