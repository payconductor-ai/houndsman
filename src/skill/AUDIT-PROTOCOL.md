# Protocolo de Auditoria dos Revisores — houndsman

Referência do Modo B do skill `update-houndsman`. Objetivo: garantir que as regras dos
revisores validam **apenas padrões que o projeto aplica hoje**. Regras "utópicas" (não
aplicadas em nenhuma parte do código) devem ser **removidas**, não apenas rebaixadas.

---

## Entradas

1. `.houndsman/reviewers/<id>.ts` — `REVIEWER_DEFINITIONS[<id>]` é a fonte única de verdade:
   `description`, `scope`, `criticalRules`, `antiPatterns`, `classify`, `contextFiles`,
   `reviewFocus`, `exclude`.
2. `src/core/brief.ts` (no motor) — `PROCEDURE` (passos de revisão compartilhados).
3. Ground truth (padrões reais do projeto):
   - Documentos de convenção do projeto (ex.: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`).
   - Documentação de arquitetura/domínio do projeto.
   - Código-fonte real do domínio (fonte final da verdade).

## Regra de ouro

> A **ausência** de um padrão no código é evidência de que ele **não é aplicado**.
> Não inferir intenção aspiracional. Se não existe hoje, a regra é `UTOPIAN`.

Use `grep_search`/`file_search`/`read_file` para **provar** cada veredito. Nunca
classifique sem evidência (caminho de arquivo, linha, ou "0 ocorrências via grep X").

## Taxonomia de veredito

| Veredito | Significado | Ação proposta |
|---|---|---|
| `ALIGNED` | Padrão documentado E aplicado no código | Manter |
| `UTOPIAN` | Não aplicado em lugar nenhum hoje | **Remover** |
| `OUTDATED` | Já foi aplicado, mas o código mudou | Remover ou reescrever |
| `MISCALIBRATED` | Regra válida, mas severidade errada | Ajustar severidade |
| `DEAD-PATH` | `scope`/`contextFiles`/`classify` apontam para caminho/arquivo inexistente | Corrigir ou remover |

## Formato do relatório

Gravar `.houndsman-audit/<reviewer-id>.md`:

```markdown
# Auditoria — <Nome do revisor> (`<reviewer-id>`)

## Ground truth do domínio
- Padrões reais observados (com caminhos de arquivo).
- Caminhos reais do domínio (confirmar existência).

## Veredito por regra

| # | Tipo | Severidade atual | Regra | Veredito | Evidência | Ação proposta |
|---|---|---|---|---|---|---|
| 1 | critical | blocking | <texto da regra> | UTOPIAN | 0 matches em `src/...` | Remover |
| ... |

## Correções de metadados
- `scope`: ...
- `contextFiles`: ...

## Protocolo (procedimento)
- Ajustes no `PROCEDURE` compartilhado (`src/core/brief.ts`) ou no `reviewFocus`/`exclude` do revisor.

## Resumo
- Total de regras: N · ALIGNED: N · UTOPIAN: N · OUTDATED: N · MISCALIBRATED: N · DEAD-PATH: N
- Regras a remover: ...
- Regras a corrigir: ...
```

## Consolidação

- Um relatório consolidado em `.houndsman-audit/audit-summary.md`.
- Agrupar **temas transversais** (ex.: a mesma regra aparecia em 2 revisores).
- Resolver conflitos: uma regra duplicada entre revisores deve viver no revisor dono do domínio.

## Disparo dos subagentes

- 1 subagente por revisor; despachar em ondas paralelas (ex.: 8 + 7).
- Prompt mínimo:

  > Você é um auditor do skill `houndsman` do {{projectName}}. Leia e siga
  > `.houndsman/skill/AUDIT-PROTOCOL.md`. Revisor alvo: `<reviewer-id>`. Audite CADA regra de
  > `REVIEWER_DEFINITIONS["<reviewer-id>"]` contra o código/docs reais, provando cada veredito.
  > Grave `.houndsman-audit/<reviewer-id>.md`. Retorne: contagem por veredito,
  > regras a REMOVER e a CORRIGIR. Não altere outros arquivos.

## Idioma

Relatórios em português. Código e identificadores em inglês. Seja sucinto.
