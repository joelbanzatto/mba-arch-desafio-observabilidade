import http from 'node:http';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import {
  consumirPedido,
  criarConexaoRedis,
  extrairContextoDaMensagem,
  type MensagemPedido,
} from '../fila/fila';
import { log } from '../telemetria/log';
import {
  TIPO_DE_CONTEUDO,
  coletar,
  pedidosConfirmados,
} from '../telemetria/metricas';
import { decidirStatusDoPedido } from './conciliacao';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);
const tracer = trace.getTracer('loja-pedidos');

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('Worker listening on port ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: MensagemPedido): Promise<void> {
  const pedidoId = Number(mensagem.pedido_id);
  const clienteId = String(mensagem.cliente_id);
  const valorTotal = Number(mensagem.valor_total);
  const contextoPai = extrairContextoDaMensagem(mensagem);

  return context.with(contextoPai, async () =>
    tracer.startActiveSpan(
      'pedido.processar',
      { attributes: { 'pedido.id': pedidoId } },
      async (span) => {
        try {
          log.info('Order message received from queue', { pedido_id: pedidoId });

          const status = await decidirStatusDoPedido(clienteId, valorTotal, pedidoId);
          await atualizarStatusPedido(pedidoId, status);

          if (status === 'confirmado') {
            pedidosConfirmados.inc();
          }

          log.info('Order status updated to ' + status, { pedido_id: pedidoId });
        } catch (erro) {
          const excecao = erro instanceof Error ? erro : new Error(String(erro));
          span.recordException(excecao);
          span.setStatus({ code: SpanStatusCode.ERROR, message: excecao.message });
          log.error('Order processing failed: ' + excecao.message, {
            pedido_id: pedidoId,
          });
          throw erro;
        } finally {
          span.end();
        }
      }
    )
  );
}

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  const encerrar = () => {
    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('Worker consuming the order queue');

  while (rodando) {
    try {
      const mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      log.error('Queue processing failed: ' + (erro as Error).message);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  log.error('Worker failed to start: ' + erro.message);
  process.exit(1);
});
