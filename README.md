# Orders observability challenge

This project instruments the order API and asynchronous worker with logs, traces, Prometheus metrics, a provisioned Grafana dashboard, and an SLO-derived alert. The intentionally faulty payment outcome remains unchanged so the scenario can be investigated.

## Como rodar

1. Clone the repository and enter the project directory:

   ```sh
   git clone https://github.com/joelbanzatto/mba-arch-desafio-observabilidade.git
   cd mba-arch-desafio-observabilidade
   ```

2. Create local configuration from the example:

   ```sh
   cp .env.example .env
   ```

3. Start the complete stack:

   ```sh
   docker compose up -d --build
   ```

4. Confirm the application is ready:

   ```sh
   curl --fail http://localhost:8080/health
   curl --fail http://localhost:8081/health
   ```

5. Open Grafana at `http://localhost:3000` with the credentials in `.env`, Jaeger at `http://localhost:16686`, and Prometheus at `http://localhost:9090`.

Run the healthy workload with `docker compose run --rm carga normal`. To reproduce the financial incident, use `docker compose run --rm carga cenario-a`; it runs until interrupted. The alert receiver is available at `http://localhost:9099` and its deliveries can be inspected with `docker compose logs receptor-alertas`.

## Equivalências com o curso

| Concern | Java course approach | TypeScript implementation |
| --- | --- | --- |
| Metrics | Micrometer counters and registries | `prom-client` counters registered in `src/telemetria/metricas.ts` |
| Tracing | OpenTelemetry bridge and automatic instrumentation | `@opentelemetry/sdk-node`, automatic HTTP/database instrumentation, and manual spans through `@opentelemetry/api` |
| Structured logs | SLF4J application logs enriched with trace context | JSON stdout logger in `src/telemetria/log.ts` with `trace_id` and `span_id` on every line |
| Context propagation | W3C Trace Context between services | OpenTelemetry `propagation.inject` and `propagation.extract` in the Redis queue message |

## Decisões técnicas

### Correlated logs and traces

The API creates the `pedido.criar` span and the worker continues it as `pedido.processar`. The queue message carries W3C context, so Jaeger, API logs, and worker logs share a trace ID. Order-related logs include `pedido_id`; startup logs retain empty trace fields instead of changing their schema.

### Stable metrics

The original HTTP metric used the concrete `requisicao.path` as a label. A route such as `/produtos/42` would create a new Prometheus series for every possible ID, eventually increasing memory, storage, query cost, and cardinality without bound. The instrumentation now records Express route templates such as `/produtos/:id` and falls back to the bounded `unmatched` value.

Business metrics deliberately have no customer or order identifiers as labels:

| Metric | What it answers |
| --- | --- |
| `pedidos_criados_total` | How many orders entered the asynchronous workflow? |
| `pedidos_confirmados_total` | How many orders reached the customer-visible confirmed state? |
| `cobrancas_processadas_total{resultado}` | Did a charge finish as approved, declined, or unexpectedly fail? |

All business series are initialized at process startup. This keeps healthy zero values visible to dashboards and alert queries.

### Dashboard questions

The provisioned **Orders** dashboard has three panels:

| Panel | Operational question answered |
| --- | --- |
| **Is the system failing? Charge failure rate** | Whether unexpected charge failures are occurring, using the share of `resultado="falha"`. |
| **Is the system slow? API p95 latency** | Whether the API is slow, using `histogram_quantile` over the HTTP duration histogram. |
| **Is money entering? Approved charges per second** | Whether the payment gateway is approving charges, using the approved-charge rate as the cash-in signal. |

The dashboard has no manual-only state: it is versioned at `grafana/provisioning/dashboards/pedidos.json` and is provisioned on startup.

The exception-swallowing behavior in `src/worker/conciliacao.ts` is intentionally not corrected. The objective is to expose the inconsistency between a confirmed order and a failed charge, not to change the application’s functional behavior.

## SLO e alerta

### SLI

The charge-processing success ratio is the fraction of charge attempts that do **not** end in an unexpected failure:

```promql
1 - (
  sum(rate(cobrancas_processadas_total{resultado="falha"}[2m]))
  /
  clamp_min(sum(rate(cobrancas_processadas_total[2m])), 0.001)
)
```

Legitimate declines remain successful processing outcomes for this SLI because the gateway returned a business decision; only `falha` represents an unexpected processing failure.

### SLO and alert derivation

The SLO is **99% successful charge processing over a rolling 30-day window**. It permits a 1% error budget:

```text
error budget = 1 - 0.99 = 0.01 (1%)
fast-burn alert threshold = 3 × 0.01 = 0.03 (3%)
```

`prometheus/regras/cobrancas.yml` defines the exact alert name `FalhaEmCobrancas`. It fires when the two-minute failure ratio exceeds 3% for 45 seconds. This is a three-times burn rate of the SLO’s error budget, rather than an arbitrary threshold. Alertmanager then adds its configured 10-second group wait before the receiver sees the notification.
