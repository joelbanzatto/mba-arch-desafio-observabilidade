import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from '../telemetria/log';
import { cobrancasProcessadas } from '../telemetria/metricas';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number,
  pedidoId: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    cobrancasProcessadas.labels(resultado.aprovado ? 'aprovada' : 'recusada').inc();
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
}
