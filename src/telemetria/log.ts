import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';
type CamposDoLog = {
  pedido_id?: number;
};

function camposDeRastreamento(): { trace_id: string; span_id: string } {
  const contextoDoSpan = trace.getSpan(context.active())?.spanContext();

  if (!contextoDoSpan || !isSpanContextValid(contextoDoSpan)) {
    return { trace_id: '', span_id: '' };
  }

  return {
    trace_id: contextoDoSpan.traceId,
    span_id: contextoDoSpan.spanId,
  };
}

function escrever(level: Nivel, msg: string, campos: CamposDoLog = {}): void {
  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    ...camposDeRastreamento(),
    ...campos,
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, campos?: CamposDoLog): void {
    escrever('info', msg, campos);
  },
  warn(msg: string, campos?: CamposDoLog): void {
    escrever('warn', msg, campos);
  },
  error(msg: string, campos?: CamposDoLog): void {
    escrever('error', msg, campos);
  },
};
