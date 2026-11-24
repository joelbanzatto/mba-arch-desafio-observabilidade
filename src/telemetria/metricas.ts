import client from 'prom-client';

export const registro = new client.Registry();

client.collectDefaultMetrics({ register: registro });

export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Total number of orders created',
  registers: [registro],
});

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Total number of confirmed orders',
  registers: [registro],
});

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Total number of processed charges by result',
  labelNames: ['resultado'],
  registers: [registro],
});

pedidosCriados.inc(0);
pedidosConfirmados.inc(0);
cobrancasProcessadas.labels('aprovada').inc(0);
cobrancasProcessadas.labels('recusada').inc(0);
cobrancasProcessadas.labels('falha').inc(0);

export const TIPO_DE_CONTEUDO = registro.contentType;

export function coletar(): Promise<string> {
  return registro.metrics();
}
