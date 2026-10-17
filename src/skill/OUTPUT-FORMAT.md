# Formato de Saída dos Watchdogs

Todo watchdog DEVE gravar **um arquivo JSON** com seus achados. O `report-builder.ts`
consolida os JSONs no artefato `review.md` do storage global.

> **Não** escrever markdown livre no chat. O único output consumido pelo pipeline é o JSON.

## Caminho do arquivo

O caminho exato é informado no brief do watchdog (gerado por `houndsman`). Ele aponta para o
staging global da review:

```
<HOUNDSMAN_HOME>/work/<reviewId>/findings/<watchdogId>.json
```

- `<reviewId>`: UUID da review (estável entre prepare/finalize).
- `<watchdogId>`: id do watchdog (ex.: `backend-architecture`).
- Use exatamente o `outputPath` do brief — não invente caminhos.

## Schema

```json
{
  "watchdogId": "backend-architecture",
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
| `watchdogId` | string | ✅ | Id do watchdog (deve casar com uma chave de `.houndsman/watchdogs/index.ts`) |
| `reviewedFiles` | string[] | ✅ | Arquivos efetivamente inspecionados |
| `skipped` | string[] | ✅ | Arquivos do domínio que NÃO foram lidos + motivo |
| `findings` | object[] | ✅ | Achados (vazio se nada encontrado) |
| `findings[].rule` | string | ✅ | Regra violada (conforme o brief do watchdog) |
| `findings[].severity` | `"blocking" \| "attention" \| "suggestion" \| "nit"` | ✅ | Severidade |
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
| `nit` | 🔎 | Não (detalhe/observação) |

## Regras

- Sem achados → `"findings": []` (arquivo **obrigatório**).
- Um achado por regra violada; não agrupar regras diferentes.
- `file:line` sempre que possível; `evidence` quando o achado não é óbvio.
- Não inventar achados — se não houver violação, o array fica vazio.

## Findings emergentes (opt-in)

Quando o watchdog declara `allowEmergentFindings: true`, você pode reportar falhas de
**lógica** ou **domínio** que não correspondem a uma regra explícita usando os prefixos
reservados:

- `Lógica: <descrição>` — nome/contrato vs comportamento, fluxos, estados, bordas.
- `Domínio: <descrição>` — transições, idempotência, invariantes, arredondamento, timezone.

Esses findings continuam exigindo `evidence` e têm severidade máxima `attention`. Sem o
opt-in, todo finding precisa citar uma regra existente.
