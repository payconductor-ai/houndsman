# houndsman — {{projectName}} · `fix` (correção dos findings)

> **Documento canônico da capability `fix`.** O entry point do skill é o `SKILL.md`
> (`.agents/skills/houndsman/SKILL.md` e `.claude/skills/houndsman/SKILL.md`).

Corrige os achados de uma revisão **já finalizada** (`hunt`): lê a triagem, aplica as
correções marcadas e mantém o estado de triagem em dia — **sem editar o `state.json` à mão**.

Invocação: `/houndsman fix`. Não revisa nem altera regras; consome o que o `hunt` produziu.

**Quando usar:**

- Depois de `/houndsman` (ou `houndsman --finalize`), para corrigir os achados.
- O usuário marcou achados como `execute` na UI (`bun run houndsman server --open`) ou via
  `findings set <id> --decision execute`.
- "Corrija os findings", "aplica as correções", "resolve os bloqueantes".

> **Pré-requisito:** existe `.houndsman/.runs/<branch-slug>/state.json` da run atual
> (gerado no `--finalize`). Se não existir, a revisão não foi finalizada — rode o `hunt` antes.
> A triagem (`execute`) é feita na UI (`bun run houndsman server --open`) ou via `findings set`,
> e é o que alimenta a fila de correção.

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

## Procedimento (incremental — nunca de uma vez)

Em PRs grandes há muitos achados. **Nunca** carregue a fila inteira: o `batch` entrega um
**grupo coeso, já paginado**, e a fila avança sozinha conforme você conclui os itens.

```
repita:
  1. findings summary --json        # contagem barata da fila
  2. fila vazia? → fim
  3. findings batch --json          # grupo atual + outros grupos (sem parâmetros)
  4. corrigir APENAS o grupo atual
  5. findings sync                  # reancora por conteúdo (uma vez)
  6. findings done <ids> | set --decision pending --comment <motivo>
até a fila esvaziar
```

### 1. Medir a fila

```bash
bun run houndsman findings summary --json
```

`byDecision.execute` (menos os `done`) é o tamanho da fila. Se for `0`, acabou.

### 2. Pegar o lote (contexto para correção)

```bash
bun run houndsman findings batch --json
```

O `batch` decide sozinho o **melhor agrupamento** para a run atual (por arquivo, por regra ou
por watchdog) e devolve:

- o **grupo atual** (paginado) — a unidade de trabalho;
- a lista dos **outros grupos disponíveis**;
- os totais (`fila`, `retornados`, `grupos`).

Sem parâmetros, ele devolve **o primeiro grupo**. Como a fila exclui o que já está `done`,
cada chamada após progresso traz **o próximo grupo naturalmente** — não há contador para
gerenciar.

Flags (use só quando precisar — o mínimo de decisão):

| Flag | Quando usar |
|---|---|
| `--severity blocking` | Só os bloqueantes (ex.: "quero corrigir apenas os bloqueantes"). |
| `--group <key>` | Focar um grupo específico (a key aparece em "outros grupos"). |
| `--offset <n>` | Paginar dentro de um grupo grande. Raramente necessário. |
| `--include-done` | Auditar/rever itens já concluídos. |

### 3. Corrigir apenas o grupo atual

Para cada finding do grupo: abra o arquivo, leia o trecho ancorado (`line` é cache; confirme
pelo conteúdo) e aplique a **correção mínima** que satisfaz a `rule`, seguindo a **`action`** e
a `evidence`. Respeite o padrão que o watchdog cobra — não introduza um novo anti-padrão para
"calar" o finding. Marque antes: `findings set <id> --exec in_progress`.

**Contexto grande? Use um subagente** (ver abaixo) para o grupo — um grupo por vez.

### 4. Reancorar o estado

```bash
bun run houndsman findings sync
```

O `sync` reancora cada finding por **conteúdo** (trecho + contexto) e reporta `ok` / `moved` /
`stale`: âncora corrigida → vira `done` (quando a decisão era `execute`); âncora sumida de
outro modo → `stale` (revisar).

### 5. Confirmar ou devolver

```bash
bun run houndsman findings done <id...>          # corrigidos
bun run houndsman findings set <id> --decision pending --comment "<motivo / falta>"  # não corrigidos
```

Não deixe achado `execute` no limbo. `--decision ignore` só quando o achado for aceito como
não-aplicável.

### 6. Repetir

Volte ao passo 1. A fila encolhe a cada volta; o `batch` traz o próximo grupo sem `--offset`.

---

## Perguntas de decisão ao usuário

Pergunte (ferramenta de perguntas do harness) **antes** de corrigir quando o achado for:

- ambíguo ou com **múltiplas correções válidas**;
- uma mudança de **produto/arquitetura** (não é "só código");
- conflitante com outro achado/grupo.

Apresente o achado (`rule`, `message`, `action`, `evidence`) e as opções. Com a resposta,
registre-a: `findings set <id> --comment "<decisão>"`. Sem resposta, devolva à fila com
`--decision pending --comment "Aguardando decisão: …"` — **nunca "chute"**.

---

## Subagentes — contexto, não velocidade

Subagente serve para **isolar contexto**, não para paralelizar. Regras:

- **Um grupo por vez, em sequência.** Não dispare uma onda paralela: grupos podem editar o
  mesmo arquivo, arquivos relacionados, imports ou código gerado — correções concorrentes
  colidem.
- O subagente recebe **só** o grupo atual (findings + arquivo) e devolve um resumo compacto
  (ids corrigidos / não corrigidos + motivo). Assim o agente principal não carrega o arquivo.
- A escrita do `state.json` fica **centralizada no agente principal**: o subagente apenas
  lê/edita; `sync` / `done` / `set` são do orquestrador. Nada de `findings` dentro do subagente.
- Grupos pequenos (1–2 findings) o próprio agente corrige inline.

Prompt do subagente (modelo):

```
Corrija APENAS os findings abaixo, sem tocar em mais nada. Aplique a correção mínima que
satisfaz cada `rule`, seguindo `action`/`evidence`. Não rode comandos `findings`.
Retorne: id → corrigido/não corrigido + 1 linha de motivo.

Arquivo: <file>
- <id> [<severity>] <rule> (linha <line>) — <message>
  Ação: <action>
  Evidência: `<evidence>`
```

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

- ❌ Carregar a fila inteira de uma vez (`findings list` sem filtro) — use `findings batch`.
- ❌ Corrigir vários grupos em paralelo (subagentes simultâneos sobre arquivos que se relacionam).
- ❌ Editar `.houndsman/.runs/<slug>/state.json` à mão — use os comandos `findings`.
- ❌ Corrigir findings `pending` ou `ignore` sem o usuário marcar `execute`.
- ❌ Chavear por `(file, line)` — a confiança é o **fingerprint** de conteúdo.
- ❌ Correção cosmética para "sumir" com o finding sem atender a `rule`.
- ❌ Reescrever o arquivo inteiro — correção mínima e localizada.
- ❌ Inventar mudança de produto/arquitetura para fechar um achado ambíguo — pergunte.
- ❌ Marcar `done` sem ter aplicado a correção (o `sync` reancora; o achado volta).
