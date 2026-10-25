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
      "evidence": "import { db } from '../db'",
      "scenario": "request autenticada em /orders executa a query na rota",
      "impact": "acoplamento e bypass das regras do service",
      "confidence": 0.9,
      "basis": "logic"
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
| `findings[].scenario` | string | — | Gatilho concreto que expõe o gap (ex.: "renovação de assinatura Pix sem split") |
| `findings[].impact` | string | — | Consequência observável (ex.: "cobrança recriada sem o split configurado") |
| `findings[].confidence` | number | — | Confiança do revisor (0–1) |
| `findings[].basis` | `"rule" \| "logic" \| "domain"` | — | Origem do achado; inferida pelo prefixo `Lógica:`/`Domínio:` |

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
- **Escopo do diff:** a `line` deve cair dentro das faixas listadas em
  *Escopo do diff (símbolos alterados)* no brief. Código fora delas é contexto — não é
  achado desta revisão. Se a alteração quebra código não alterado, ancore o finding na
  linha alterada que causou o problema.
- Achado **sem linha** só quando for inerente à alteração (vira comentário de arquivo).
- Não inventar achados — se não houver violação, o array fica vazio.

## Findings emergentes (obrigatórios no `general`)

O watchdog `general` (id reservado, sempre ativo) **deve** reportar gaps de lógica e domínio
que não correspondem a uma regra explícita, usando os prefixos reservados:

- `Lógica: <descrição>` — nome/contrato vs comportamento, fluxos, estados, bordas.
- `Domínio: <descrição>` — transições, idempotência, invariantes, arredondamento, timezone,
  paridade de capacidade, propagação de credencial.

Demonstre o gap em três partes:

1. `scenario` — o gatilho concreto (ex.: "`AsaasSplit` recebe `RenewAutomaticPix`").
2. `message` — o comportamento observado e o invariante/regra violado.
3. `evidence` — o trecho que comprova.

**Severidade:** fora de regra, `blocking` só é aceito com `scenario` **e** `evidence`. Sem os
dois, o motor rebaixa para `attention` (e registra um aviso). Regras explícitas mantêm a
severidade declarada pelo watchdog.

Os demais watchdogs podem usar os mesmos prefixos apenas quando declararem
`allowEmergentFindings: true`.
