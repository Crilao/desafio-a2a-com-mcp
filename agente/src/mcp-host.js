/**
 * O agente como host MCP.
 *
 * O agente descobre as ferramentas por `tools/list` em runtime - nao existe
 * lista de tools escrita no codigo - e le o resource da politica para tirar
 * dali a versao. As duas coisas acontecem antes da primeira chamada.
 *
 * O ponto delicado e o MRTR. Por padrao o cliente do SDK responde a elicitation
 * sozinho e refaz a chamada internamente, e ai a Task nunca pausa e metade do
 * desafio evapora. Por isso `autoFulfill: false` e `allowInputRequired: true`:
 * o `input_required` chega cru na mao do agente, que decide o que fazer com ele.
 *
 * Nao ha sessao. O `versionNegotiation` e fixado na revisao 2026-07-28 para que
 * cada request carregue o proprio envelope, sem depender de handshake anterior.
 */

import { Client, StreamableHTTPClientTransport, isInputRequiredResult, withInputRequired } from '@modelcontextprotocol/client';
import { z } from 'zod';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:7301/mcp';
const PROTOCOLO = '2026-07-28';

/**
 * O cliente fica vivo entre as chamadas - isso e normal e recomendado. O que
 * nao pode haver e estado de protocolo: cada request leva o proprio `_meta`.
 */
let cliente;
let nomesDeFerramentas;
let versaoDaPolitica;

async function conectar() {
  if (cliente) return cliente;

  const novo = new Client(
    { name: 'agente-central-de-salas', version: '1.0.0' },
    {
      // Declarado em toda request: e o que autoriza o servidor a pedir elicitation.
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: PROTOCOLO } },
      // Sem isto o SDK responderia a elicitation no lugar do cliente A2A.
      inputRequired: { autoFulfill: false },
    },
  );

  await novo.connect(new StreamableHTTPClientTransport(new URL(URL_MCP)));
  cliente = novo;
  return cliente;
}

/** Descoberta em runtime. A lista de tools nao existe no codigo. */
export async function descobrirFerramentas() {
  if (nomesDeFerramentas) return nomesDeFerramentas;
  const c = await conectar();
  const lista = await c.listTools();
  nomesDeFerramentas = new Set(lista.tools.map((t) => t.name));
  return nomesDeFerramentas;
}

/** A versao da politica vem do resource, da primeira linha do markdown. */
export async function lerVersaoDaPolitica() {
  if (versaoDaPolitica) return versaoDaPolitica;
  const c = await conectar();
  const resposta = await c.readResource({ uri: 'politica://uso' });
  const texto = resposta.contents?.[0]?.text ?? '';
  const primeira = texto.split('\n', 1)[0];
  const valor = primeira.slice(primeira.indexOf(':') + 1).trim();
  if (!valor) throw new Error('a politica lida do resource nao declara a versao');
  versaoDaPolitica = valor;
  return versaoDaPolitica;
}

function metaComTrace(traceparent) {
  return traceparent ? { traceparent } : {};
}

/**
 * Chama `reservar_sala` e devolve o resultado CRU: pode ser um
 * `CallToolResult` ou um `InputRequiredResult`, e quem decide e o chamador.
 */
export async function chamarReserva({ sala, inicio, fim, responsavel, traceparent }) {
  const c = await conectar();
  return c.request(
    {
      method: 'tools/call',
      params: {
        name: 'reservar_sala',
        arguments: { sala, inicio, fim, responsavel },
        _meta: metaComTrace(traceparent),
      },
    },
    withInputRequired(z.any()),
    { allowInputRequired: true },
  );
}

/**
 * O retry. E um request novo, com id de JSON-RPC novo - a spec exige que ele
 * difira do inicial, porque sao requests independentes. O `requestState` e
 * ecoado sem modificacao: o agente nunca o abre nem o reconstroi.
 */
export async function retomarReserva({
  arguments: argumentos,
  chave,
  resposta,
  requestState,
  traceparent,
}) {
  const c = await conectar();
  return c.request(
    {
      method: 'tools/call',
      params: {
        name: 'reservar_sala',
        arguments: argumentos,
        inputResponses: { [chave]: resposta },
        requestState,
        _meta: metaComTrace(traceparent),
      },
    },
    withInputRequired(z.any()),
    { allowInputRequired: true },
  );
}

export { isInputRequiredResult };

/** Texto que a tool devolveu, usado para levar a mensagem exata ate a Task. */
export function textoDoResultado(resultado) {
  return (resultado?.content ?? [])
    .map((bloco) => bloco?.text ?? '')
    .join(' ')
    .trim();
}
