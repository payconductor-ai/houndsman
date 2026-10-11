# Formato de Saída dos Revisores

Todo revisor DEVE gravar **um arquivo JSON** com seus achados. O `report-builder.ts`
consolida os JSONs em `.houndsman/.runs/<branch-slug>/review.md`.

> **Não** escrever markdown livre no chat. O único output consumido pelo pipeline é o JSON.

## Caminho do arquivo

O caminho exato é informado no brief do revisor (gerado por `houndsman`):

```
.houndsman/.runs/<branch-slug>/findings/<reviewerId>.json
```

- `<branch-slug>`: branch com `/` substituído por `-` (ex.: `feature/x` → `feature-x`).
- `<reviewerId>`: id do revisor (ex.: `backend-architecture`).

## Schema

```json
{
  "reviewerId": "backend-architecture",
  "reviewedFiles": ["src/services/order/order-service.ts"],
  "skipped": [],
  "findings": [
    {
      "rule": "Route acessando db",
      "severity": "blocking",
      "file": "src/routes/order-route.ts",
      "line": 5,
      "message": "Arquivo de rota importa `db` e executa query inline.",
      "action": "Mover a query para o service correspondente.",
      "evidence": "import { db } from '../db'"
    }
  ]
}
```

### Campos

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `reviewerId` | string | ✅ | Id do revisor (deve casar com uma chave de `.houndsman/reviewers/index.ts`) |
| `reviewedFiles` | string[] | ✅ | Arquivos efetivamente inspecionados |
| `skipped` | string[] | ✅ | Arquivos do domínio que NÃO foram lidos + motivo |
| `findings` | object[] | ✅ | Achados (vazio se nada encontrado) |
| `findings[].rule` | string | ✅ | Regra violada (conforme o brief do revisor) |
| `findings[].severity` | `"blocking" \| "attention" \| "suggestion"` | ✅ | Severidade |
| `findings[].file` | string | ✅ | Caminho relativo à raiz |
| `findings[].line` | number | — | Linha do achado |
| `findings[].message` | string | ✅ | O que está errado (curto, específico) |
| `findings[].action` | string | ✅ | O que fazer |
| `findings[].evidence` | string | — | Trecho que comprova o achado |

## Severidade

| Severidade | Emoji | Bloqueia merge? |
|---|---|---|
| `blocking` | ❌ | Sim |
| `attention` | ⚠️ | Não (requer atenção) |
| `suggestion` | 💡 | Não |

## Regras

- Sem achados → `"findings": []` (arquivo **obrigatório**).
- Um achado por regra violada; não agrupar regras diferentes.
- `file:line` sempre que possível; `evidence` quando o achado não é óbvio.
- Não inventar achados — se não houver violação, o array fica vazio.
