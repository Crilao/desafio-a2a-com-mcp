/**
 * Agente A2A da Central de Salas - binding JSON-RPC 2.0 sobre HTTP.
 *
 * Por fora ele e um servidor A2A: publica o Agent Card no well-known URI e
 * aceita SendMessage e GetTask em /a2a. Por dentro ele e um host MCP, falando
 * com o servidor de salas por HTTP como um cliente MCP de verdade.
 */

import { createServer } from 'node:http';

import { ErroA2A, agentCard, getTask, sendMessage } from './a2a.js';

const PORTA = Number(process.env.AGENTE_PORT ?? 7300);
const CAMINHO_CARD = '/.well-known/agent-card.json';
const CAMINHO_A2A = process.env.AGENTE_PATH ?? '/a2a';

function baseUrl(req) {
  const host = req.headers.host;
  if (host) return `http://${host}`;
  return `http://127.0.0.1:${PORTA}`;
}

async function lerCorpo(req) {
  const partes = [];
  for await (const pedaco of req) partes.push(pedaco);
  return Buffer.concat(partes).toString('utf8');
}

function responder(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

async function tratarJsonRpc(corpo, traceparent) {
  const { id, method, params } = corpo ?? {};

  try {
    if (method === 'SendMessage') {
      return { jsonrpc: '2.0', id, result: { task: await sendMessage(params, traceparent) } };
    }
    if (method === 'GetTask') {
      return { jsonrpc: '2.0', id, result: { task: getTask(params) } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Metodo nao suportado: ${method}` },
    };
  } catch (erro) {
    if (erro instanceof ErroA2A) {
      return { jsonrpc: '2.0', id, error: { code: erro.code, message: erro.message } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: String(erro?.message ?? erro) },
    };
  }
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', baseUrl(req));

  if (req.method === 'GET' && url.pathname === CAMINHO_CARD) {
    responder(res, 200, agentCard(baseUrl(req)));
    return;
  }

  if (url.pathname !== CAMINHO_A2A) {
    responder(res, 404, { erro: `Endpoint inexistente: ${url.pathname}` });
    return;
  }

  if (req.method !== 'POST') {
    responder(res, 405, { erro: 'Use POST no endpoint A2A.' });
    return;
  }

  let corpo;
  try {
    corpo = JSON.parse(await lerCorpo(req));
  } catch {
    responder(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // O traceparent do cliente A2A viaja ate o servidor MCP dentro do _meta de
  // cada request daquela Task. O span-id pode ser novo; o trace-id nao.
  const traceparent = req.headers.traceparent;

  process.stderr.write(
    `[a2a] method=${corpo?.method ?? '-'} id=${JSON.stringify(corpo?.id ?? null)} traceparent=${traceparent ?? '-'}\n`,
  );

  responder(res, 200, await tratarJsonRpc(corpo, traceparent));
});

servidor.listen(PORTA, () => {
  process.stderr.write(`[a2a] central-de-salas ouvindo em http://localhost:${PORTA}${CAMINHO_A2A}\n`);
});
