# houndsman — {{projectName}} · `verify` (violações resolvidas?)

> **Documento canônico da capability `verify`.** O entry point do skill é o `SKILL.md`
> (`.agents/skills/houndsman/SKILL.md` e `.claude/skills/houndsman/SKILL.md`).

Confere se os findings de uma revisão **já finalizada** foram resolvidos — **sem re-revisar a
PR**. Invocação: `/houndsman verify`. Consome a triagem persistida pelo `hunt`; não revisa nem
altera regras.

**Quando usar:**

- Depois de corrigir achados (`fix`), para confirmar que as violações sumiram.
- As violações foram resolvidas? · confere se ainda está lá · valida o fix.

> **Pré-requisito:** existe uma review com findings persistidos (gerada no `--finalize`).

---

## Como funciona (2 tiers)

1. **Tier local (grátis, determinístico).** Para cada finding presente, reancora a âncora de
   conteúdo contra o working tree (`core/finding-anchor.ts`):
   - **âncora presente** (`ok`/`moved`) → **persiste** (a violação ainda está lá);
   - **âncora sumida** (`stale`) → provável **resolvido** — mas o trecho pode ter sido reescrito;
   - **arquivo ausente** → fora da verificação (deletado/movido).

2. **Tier Jev (opcional, só nos ambíguos).** Com `TYPESAFE_API_KEY`, os casos `stale` / sem
   âncora são confirmados pelo LLM sobre um **diff focado** do arquivo (`foundAtSha..HEAD`), uma
   pergunta `noul` por finding. Falha-aberto: sem chave/erro → vale o resultado local.

**Custo:** ~0 LLM quando o tier local decide; 1 chamada por arquivo ambíguo — nunca uma revisão
completa.

---

## Procedimento

```bash
bun run houndsman findings verify            # relatório (não altera o estado)
bun run houndsman findings verify --json     # saída estruturada
bun run houndsman findings verify --apply    # marca os resolvidos como done (ping no status)
```

- Sem `--apply`: **só relatório** (grava o artefato `verify.md` no storage). Nada muda na triagem.
- Com `--apply`: os findings com status **`resolved`** viram `execState: done` (histórico
  `by: "verify"`) e a **thread correspondente é resolvida no GitHub** (quando há comentário e a
  conversa ainda está aberta; fail-open). `persisting` e `uncertain` **não** são tocados.

Filtros (como no `findings list`): `--severity`, `--watchdog`, `--file`, `--decision`. `--all`
inclui ausentes. `--no-jev` desliga o tier LLM. `--fail-on-persisting` sai com código 1 se algum
`blocking` persistir (útil em CI).

---

## Status possíveis

| Status | Significado | `--apply`? |
|---|---|---|
| `resolved` | Violação não encontrada (âncora sumida; confirmada pelo Jev quando há chave). | ✅ vira `done` |
| `persisting` | Âncora ainda presente — a violação continua. | ❌ |
| `uncertain` | Sem âncora e sem confirmação do Jev (ou Jev indisponível). | ❌ |
| `file-missing` | Arquivo não está no working tree (deletado/movido). | ❌ |

---

## Anti-padrões

- ❌ Reexecutar o `hunt` inteiro só para conferir se um fix funcionou — use o `verify`.
- ❌ Esperar que o `verify` marque `done` sem `--apply` (sem a flag, nada muda no estado).
- ❌ Tratar `persisting` como resolvido — a âncora ainda está no arquivo.
- ❌ Esperar verificação 100% pelo LLM — o tier local resolve a maioria de graça.
