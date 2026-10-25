# Resumo da revisão — feature/add-webhook-retry

**Data:** 2026-04-20 · **Status:** ❌ Mudanças Necessárias

## Resumo de negócio

Tornar o envio de webhooks resiliente a falhas temporárias do destinatário, sem perda de
eventos e sem reenvio manual.

**Invariantes:**
- Todo evento entregue tem no máximo uma tentativa `in_flight` por destinatário.
- O retry nunca duplica o `eventId` já aceito pelo integrador.

**Fluxos (2):**
- **Retry de webhook** — disparo: resposta não-2xx/timeout — esperado: reagendamento com
  backoff exponencial e registro da tentativa.

## Pontos técnicos

- **Contratos** — `WebhookRetryPolicy`, `RetryAttempt` (`src/webhooks/types.ts`).
- **Implementações** — `WebhookDispatcher` (`src/webhooks/dispatcher.ts`).
- **Novas dependências** — `p-retry`.

## Cobertura por domínio

| Domínio | Achados | Revisados | Faltam |
|---|---|---|---|
| Arquitetura Backend | 2 | 3/3 | — |
| Pagamentos & Integrações | 1 | 4/4 | — |
| Acquirer Integrations | 2 | 3/4 | 1 |

## Candidatos não verificados (1)

> Indícios da pré-análise que nenhum watchdog confirmou. Não bloqueiam.

- `src/webhooks/queue.ts` · attention · Fila sem limite de tentativas.

## Conclusão

**Resumo:** 2 bloqueantes · 1 atenção · 1 sugestões · 1 nits.

> Achados individuais (com `id` de triagem) vivem na UI (`Findings`) e em
> `houndsman findings list --json` — o resumo não os duplica.
