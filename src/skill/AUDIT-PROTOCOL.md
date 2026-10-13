# Protocolo de Auditoria dos Watchdogs — houndsman

Referência do Modo B da capability `train` (skill `/houndsman`). Objetivo: garantir que as
regras dos watchdogs validam **apenas padrões que o projeto aplica hoje**. Regras "utópicas" (não
aplicadas em nenhuma parte do código) devem ser **removidas**, não apenas rebaixadas.

---

## Entradas

1. `.houndsman/watchdogs/<id>.ts` — `WATCHDOG_DEFINITIONS[<id>]` é a fonte única de verdade:
   `description`, `scope`, `rules` (severidade + texto), `classify`, `contextFiles`,
   `reviewFocus`, `exclude`.
2. `src/core/brief.ts` (no motor) — `PROCEDURE` (passos de revisão compartilhados).
3. Ground truth (padrões reais do projeto):
   - Documentos de convenção do projeto (ex.: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`).
   - Documentação de arquitetura/domínio do projeto.
   - Código-fonte real do domínio (fonte final da verdade).

## Regra de ouro

> Só é regra o que o projeto **aplica hoje** — mas como provar depende da **polaridade**:
>
> - Regra **afirmativa** (`Promover:`): a **ausência** do padrão no código prova que ele **não é
>   aplicado** → `UTOPIAN` (remover/rebaixar). Não inferir intenção aspiracional.
> - Regra **negativa** (`Evitar:`, `Não`, `Nunca`): a **ausência** do anti-padrão prova que a regra
>   **é seguida** → `ALIGNED` (**manter**). Nunca remover uma regra negativa por "0 ocorrências".

Use regra **geral e reutilizável** (padrão do domínio), nunca regra de negócio pontual amarrada a
uma classe/use-case — isso é papel de teste automatizado.

Use `grep_search`/`file_search`/`read_file` para **provar** cada veredito. Nunca
classifique sem evidência (caminho de arquivo, linha, ou "0 ocorrências via grep X").

## Taxonomia de veredito

| Veredito | Significado | Ação proposta |
|---|---|---|
| `ALIGNED` | Padrão documentado E aplicado no código (regra negativa: anti-padrão **ausente**) | Manter |
| `UTOPIAN` | Regra **afirmativa** cujo padrão não existe em lugar nenhum hoje | **Remover** |
| `OUTDATED` | Já foi aplicado, mas o código mudou | Remover ou reescrever |
| `MISCALIBRATED` | Regra válida, mas severidade errada | Ajustar severidade |
| `DEAD-PATH` | `scope`/`contextFiles`/`classify` apontam para caminho/arquivo inexistente | Corrigir ou remover |

## Formato do relatório

Gravar `.houndsman-audit/<watchdog-id>.md`:

```markdown
# Auditoria — <Nome do watchdog> (`<watchdog-id>`)

## Ground truth do domínio
- Padrões reais observados (com caminhos de arquivo).
- Caminhos reais do domínio (confirmar existência).

## Veredito por regra

| # | Severidade atual | Polaridade | Regra | Veredito | Evidência | Ação proposta |
|---|---|---|---|---|---|---|
| 1 | blocking | afirmativa | <texto da regra> | UTOPIAN | 0 matches em `src/...` | Remover |
| 2 | attention | negativa | <texto da regra> | ALIGNED | 0 ocorrências do anti-padrão | Manter |
| ... |

## Correções de metadados
- `scope`: ...
- `contextFiles`: ...

## Protocolo (procedimento)
- Ajustes no `PROCEDURE` compartilhado (`src/core/brief.ts`) ou no `reviewFocus`/`exclude` do watchdog.

## Resumo
- Total de regras: N · ALIGNED: N · UTOPIAN: N · OUTDATED: N · MISCALIBRATED: N · DEAD-PATH: N
- Regras a remover: ...
- Regras a corrigir: ...
```

## Consolidação

- Um relatório consolidado em `.houndsman-audit/audit-summary.md`.
- Agrupar **temas transversais** (ex.: a mesma regra aparecia em 2 watchdogs).
- Resolver conflitos: uma regra duplicada entre watchdogs deve viver no watchdog dono do domínio.

## Disparo dos subagentes

- 1 subagente por watchdog; despachar em ondas paralelas (ex.: 8 + 7).
- Prompt mínimo:

  > Você é um auditor do skill `houndsman` do {{projectName}}. Leia e siga
  > `.houndsman/core/skill/AUDIT-PROTOCOL.md`. Watchdog alvo: `<watchdog-id>`. Audite CADA regra de
  > `WATCHDOG_DEFINITIONS["<watchdog-id>"]` contra o código/docs reais, provando cada veredito.
  > Grave `.houndsman-audit/<watchdog-id>.md`. Retorne: contagem por veredito,
  > regras a REMOVER e a CORRIGIR. Não altere outros arquivos.

## Idioma

Relatórios em português. Código e identificadores em inglês. Seja sucinto.
