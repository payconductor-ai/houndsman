# Formato de Saída dos Watchdogs

Todo watchdog DEVE gravar **um arquivo JSON** com seus achados. O `report-builder.ts`
valida e deduplica os JSONs; o `--finalize` grava a triagem no storage e o
`review-resume.md` com a cobertura por domínio.

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
      "impactClass": "flow-break",
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
| `reviewedFiles` | string[] | ✅ | Arquivos **do seu domínio** efetivamente revisados (subconjunto de `## Arquivos do seu domínio`; não inclua chamadores/importadores nem arquivos de outros domínios) |
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
| `findings[].impactClass` | `"flow-break" \| "contract-drift" \| "degradation" \| "cosmetic"` | emergente | Classe de impacto que define a severidade fora de regra |
| `findings[].confidence` | number | — | Confiança do revisor (0–1) |
| `findings[].basis` | `"rule" \| "logic" \| "domain"` | — | Origem do achado; inferida pelo prefixo `Lógica:`/`Domínio:` |

## Severidade

A severidade é **derivada**, não escolhida pelo watchdog:

| Origem do finding | Fonte da severidade |
|---|---|
| Regra do brief (`rule` copiada) | `severity` **declarada na regra** — outro valor é ignorado e corrigido pelo motor |
| Emergente (`Lógica:`/`Domínio:`) | `impactClass`, pela tabela abaixo |

| `impactClass` | Quando usar | Severidade |
|---|---|---|
| `flow-break` | o caminho não completa (criação/renovação/cancelamento) ou a capacidade declarada não é honrada | `blocking` (exige `scenario` + `evidence`) |
| `contract-drift` | contrato, identificador ou estado divergente — mas o fluxo completa | `attention` |
| `degradation` | funciona, mas com borda, erro, retry ou idempotência frágil | `suggestion` |
| `cosmetic` | clareza, nome, detalhe cosmético | `nit` |

| Severidade | Emoji | Bloqueia merge? |
|---|---|---|
| `blocking` | ❌ | Sim |
| `attention` | ⚠️ | Não (requer atenção) |
| `suggestion` | 💡 | Não |
| `nit` | 🔎 | Não (detalhe/observação) |

> Sem `impactClass` (relatório antigo), o motor mantém o valor emitido em `severity`.
> Conflito de severidade numa mesma regra entre reviews deixa de existir: a regra é a fonte.

## Regras

- Sem achados → `"findings": []` (arquivo **obrigatório**).
- Um achado por regra violada; não agrupar regras diferentes.
- **Uma entrada por (arquivo, regra).** A mesma regra violada em vários trechos do **mesmo
  arquivo** continua sendo **um** achado: use a `line` da primeira ocorrência e descreva as
  demais no `message`. O motor colapsa repetições por `(arquivo, regra)` e por trecho
  ancorado — emitir uma por linha só infla o relatório antes de ser colapsado.
- **Teto de 20 achados por watchdog.** Se houver mais, mantenha os de maior severidade e
  agrupe ocorrências idênticas (mesmo trecho + mesma regra) em um único item. O JSON precisa
  caber inteiro — relatório cortado perde achados.
- `reviewedFiles ∪ skipped` deve cobrir **todo** o escopo do brief. O que não foi revisado
  entra em `skipped` com o motivo (`budget`, `truncated`, `fora do fluxo`).
- `file:line` sempre que possível; `evidence` quando o achado não é óbvio.
- **Trecho truncado** (`… [trecho truncado]`): sem abrir o arquivo para ver o restante, não
  afirme violação sobre ele — reduza a `confidence` ou não reporte.
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
severidade declarada **na regra**.

Os demais watchdogs podem usar os mesmos prefixos apenas quando declararem
`allowEmergentFindings: true`.
