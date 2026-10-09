/**
 * Servidor MCP da Central de Salas - Streamable HTTP, endpoint unico.
 *
 * O servidor e stateless no sentido de protocolo: uma instancia nova e criada
 * por request pelo `createMcpHandler`, e versao e capabilities vem do `_meta`
 * daquele request, nunca de um request anterior. As reservas vivem em memoria
 * no modulo de dominio, que e o unico estado que sobrevive entre requests.
 */

import { createServer } from 'node:http';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';

import { codec } from './estado.js';
import { registrar } from './ferramentas.js';

const PORTA = Number(process.env.MCP_PORT ?? 7301);
const CAMINHO = process.env.MCP_PATH ?? '/mcp';

/**
 * Uma instancia por request. O hook de verificacao do requestState e ligado
 * aqui: com ele, um requestState adulterado ou expirado e recusado pelo seam
 * com -32602 antes de o handler rodar.
 */
function fabrica() {
  const servidor = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    { requestState: { verify: (estado, ctx) => codec.verify(estado, ctx) } },
  );
  registrar(servidor);
  return servidor;
}

const manipulador = createMcpHandler(fabrica, { legacy: 'reject' });

/**
 * Registra cada request recebido no stderr. Fica na camada HTTP, e nao dentro
 * de cada handler, para que `tools/list` tambem apareca - e e no stderr, e nao
 * no logging do protocolo, que a spec manda registrar a partir de 2026-07-28.
 */
async function fetchComLog(request) {
  if (request.method === 'POST') {
    try {
      const corpo = await request.clone().json();
      const meta = corpo?.params?._meta;
      const traceparent = meta?.traceparent ?? '-';
      process.stderr.write(
        `[mcp] method=${corpo?.method ?? '-'} id=${JSON.stringify(corpo?.id ?? null)} traceparent=${traceparent}\n`,
      );
    } catch {
      // Corpo vazio ou nao-JSON: o SDK responde o erro adequado.
    }
  }
  return manipulador.fetch(request);
}

const validarHost = localhostHostValidation();
const validarOrigem = localhostOriginValidation();
const tratarNode = toNodeHandler({ fetch: fetchComLog });

const servidor = createServer((req, res) => {
  const caminho = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

  if (caminho !== CAMINHO) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: `Endpoint inexistente: ${caminho}. Use ${CAMINHO}.` }));
    return;
  }

  if (!validarHost(req, res)) return;
  if (!validarOrigem(req, res)) return;

  tratarNode(req, res);
});

servidor.listen(PORTA, () => {
  process.stderr.write(
    `[mcp] central-de-salas ouvindo em http://localhost:${PORTA}${CAMINHO} (revisao 2026-07-28)\n`,
  );
});
