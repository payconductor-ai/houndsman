# PR Review — feature/add-webhook-retry

**Data:** 2026-04-20
**Watchdogs ativos:** api-contracts, backend-architecture, payments-integrations, acquirer-integrations
**Achados:** 2 bloqueantes · 1 atenção · 1 sugestões · 1 nit

## Contexto da PR
**PR:** #482 Adicionar retry de webhooks — https://github.com/org/repo/pull/482
**Branch:** `feature/add-webhook-retry` → `main`
**Objetivo:** Tornar o envio de webhooks resiliente a falhas temporárias do destinatário.
**Motivação:** Webhooks com falha exigiam reenvio manual e causavam perda de eventos em integradores.
**Resumo das alterações:**
- Nova fila de retry para webhooks que falharam.
- Novo endpoint interno para reprocessar eventos manualmente.
- Registro de tentativas no handler de envio.

## Relatórios por domínio

| Watchdog | Achados | Revisados | Relatório |
|---|---|---|---|
| Arquitetura Backend | 2 | 3/3 | [`review.backend-architecture.md`](review.backend-architecture.md) |
| Pagamentos & Integrações | 1 | 4/4 | [`review.payments-integrations.md`](review.payments-integrations.md) |
| Acquirer Integrations | 2 | 3/4 | [`review.acquirer-integrations.md`](review.acquirer-integrations.md) |

## Cobertura

| Watchdog | Arquivos revisados | Findings |
|---|---|---|
| API & Contratos | 2 | 0 |
| Arquitetura Backend | 3 | 2 |
| Pagamentos & Integrações | 4 | 1 |
| Acquirer Integrations | 3/4 (faltam 1) | 2 |

## Conclusão

**Status:** ❌ Mudanças Necessárias
**Resumo:** 2 violações bloqueantes, 1 ponto de atenção, 1 sugestão e 1 nit.

## ❌ blocking

- **Webhook handler sem verifySignature** — `server/src/services/integrations/acquirer/webhook/handle-charge-event.ts:15` · _Acquirer Integrations, Pagamentos & Integrações_
  Payload processado antes de validar a assinatura do provider.
  **Cenário:** um POST anônimo em `/webhooks` com payload forjado.
  **Impacto:** eventos falsos disparam efeitos de domínio (cobrança marcada como paga).
  **Ação:** Validar `verifyWebhookSignature(payload, signature, secret)` antes de qualquer efeito.
  **Evidência:** `const event = JSON.parse(body)`

- **Promise não aguardada** — `server/src/services/webhook/webhook-retry-service.ts:92` · _Pagamentos & Integrações_
  `updateWebhookStatus(id, 'failed')` sem `await` — status pode não persistir antes do retorno.
  **Ação:** Adicionar `await`.

## ⚠️ attention

- **Retry sem backoff** — `server/src/services/webhook/webhook-retry-service.ts:55` · _Acquirer Integrations_
  Retry com intervalo fixo de 1s.
  **Ação:** Usar exponential backoff com jitter.

## 💡 suggestion

- **Complexidade** — `server/src/services/webhook/webhook-retry-service.ts:45-78` · _Arquitetura Backend_
  `retryWithBackoff` com 6 níveis de indentação.
  **Ação:** Extrair `calculateBackoffDelay(attempt, config)` e usar early returns.

## 🔎 nit

- **Ordem de membros** — `server/src/services/webhook/webhook-retry-service.ts:12` · _Arquitetura Backend_
  Campo privado declarado antes do construtor público.
  **Ação:** Reordenar membros (públicos primeiro).
