# Post-mortem: Confirmed orders without charges

## Resumo

During the `cenario-a` reproduction, orders whose payment gateway call failed were still recorded as `confirmado`. The customer-facing API continued to return 202 and the worker finished the order successfully from the customer’s perspective, even though no charge was approved. The new charge-failure metric, correlated logs, and trace exposed the mismatch.

## Impacto

The reproduction window began at `2026-11-24T23:39:19Z` and created 192 orders. PostgreSQL reported 83 confirmed orders for clients ending in `7`, the deterministic failure group in `cenario-a`, with a combined order value of **79,301.61 currency units**. These are the orders that had a failed payment attempt but were still marked confirmed.

The count and value came from the order database rather than from Prometheus because the business metric intentionally tracks outcome counts, not monetary value:

```sql
SELECT
  count(*) FILTER (WHERE status = 'confirmado' AND cliente_id LIKE '%7') AS affected_confirmed_orders,
  COALESCE(sum(valor_total) FILTER (WHERE status = 'confirmado' AND cliente_id LIKE '%7'), 0) AS affected_value
FROM pedidos
WHERE criado_em >= TIMESTAMPTZ '2026-11-24 23:39:19+00';
```

Result: `affected_confirmed_orders = 83`, `affected_value = 79301.61`.

## Detecção

The issue was originally discovered by financial reconciliation after the month closed. Black-box monitoring would not have detected it because the API responds successfully and the order becomes confirmed.

In this reproduction, `cenario-a` started at `23:39:19Z`, the alert expression became pending at `23:39:37Z`, and the alert receiver received `FalhaEmCobrancas` at `23:40:32Z`: **73 seconds** from traffic start. That delay includes scraping/evaluation, the 45-second `for`, and Alertmanager’s 10-second grouping delay. The difference from month-end reconciliation is the value of a business outcome metric: it detects missing money while the customer-facing path still looks healthy.

## Causa raiz

The defect is in `src/worker/conciliacao.ts`, in `decidirStatusDoPedido`. When `processarPagamento` throws, the catch block records the legacy failure but does not set `recusado` or rethrow. The unchanged return then maps the order to `confirmado`.

```ts
  } catch (erro) {
    const excecao = erro instanceof Error ? erro : new Error(String(erro));
    const span = trace.getSpan(context.active());
    span?.recordException(excecao);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: excecao.message });
    cobrancasProcessadas.labels('falha').inc();
    log.error('Payment processing failed: ' + excecao.message, { pedido_id: pedidoId });
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
```

The added telemetry observes this behavior but deliberately does not change it.

## Evidências

- **Trace:** Jaeger trace `50eb8d564c59bec4215ab87b4386965d` contains `pedido.criar` and the error-marked `pedido.processar` span for order `544`.
- **PromQL:**

  ```promql
  sum(rate(cobrancas_processadas_total{resultado="falha"}[2m]))
  /
  clamp_min(sum(rate(cobrancas_processadas_total[2m])), 0.001)
  ```

  At `23:40:51Z`, this returned `0.37676412998475906` (37.68%), above the 3% alert threshold.

- **Log search:**

  ```sh
  docker compose logs --no-log-prefix api worker | rg '50eb8d564c59bec4215ab87b4386965d'
  ```

  Result: API creation, worker queue consumption, payment error, and the later `confirmado` status all share this trace ID. The payment error states `gateway respondeu de forma inesperada`.

## Lições aprendidas

**What went well**

Trace propagation joined API creation and worker processing into one investigation path, while the `falha` outcome counter made the invisible payment error measurable.

**What went poorly**

The former telemetry measured HTTP health but not the business result of payment processing. The swallowed exception also made the worker appear successful.

**Where we got lucky**

The failure is deterministic for the scenario’s client group, so reconciliation and a direct trace could reproduce it without relying on a transient third-party outage.

## Itens de ação

| Action | Type | Priority |
| ------ | ---- | -------- |
| Change `decidirStatusDoPedido` so a gateway exception cannot result in `confirmado`; define retry or a failed-payment status. | Avoid | P0 |
| Keep `FalhaEmCobrancas` routed to the on-call responder and add a runbook link to the alert annotation. | Mitigate | P1 |
| Add a reconciliation job that compares confirmed orders with approved payments and reports the value gap. | Mitigate | P1 |
| Add automated integration coverage for the gateway-exception path before changing the business flow. | Avoid | P2 |

## Timeline

- `23:39:19Z` — Started `cenario-a`.
- `23:39:37Z` — Prometheus marked `FalhaEmCobrancas` as pending.
- `23:40:22Z` — The rule reached the firing state after its 45-second hold.
- `23:40:25Z` — Trace `50eb8d564c59bec4215ab87b4386965d` recorded API order creation, worker processing, and the gateway exception.
- `23:40:32Z` — Alertmanager delivered `FalhaEmCobrancas` to `receptor-alertas`.
- `23:41:09Z` — Last order from the scenario was persisted; the database query measured the impact.
