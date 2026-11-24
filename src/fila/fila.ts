import Redis from 'ioredis';
import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
  trace_context?: Record<string, string>;
};

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publicarPedido(
  redis: Redis,
  mensagem: Omit<MensagemPedido, 'trace_context'>
): Promise<void> {
  const contextoDeRastreamento: Record<string, string> = {};
  propagation.inject(context.active(), contextoDeRastreamento);

  await redis.lpush(
    NOME_DA_FILA,
    JSON.stringify({ ...mensagem, trace_context: contextoDeRastreamento })
  );
}

export async function consumirPedido(
  redis: Redis,
  segundosDeEspera = 5
): Promise<MensagemPedido | null> {
  const resposta = await redis.brpop(NOME_DA_FILA, segundosDeEspera);

  if (!resposta) {
    return null;
  }

  return JSON.parse(resposta[1]) as MensagemPedido;
}

export function extrairContextoDaMensagem(mensagem: MensagemPedido): Context {
  return propagation.extract(ROOT_CONTEXT, mensagem.trace_context ?? {});
}
