/**
 * As tres tools e o resource do servidor MCP.
 *
 * A tool de reserva e onde o MRTR acontece: quando o intervalo pedido conflita,
 * ela nao pergunta nada ao cliente - ela TERMINA a resposta com
 * `resultType: input_required`, carregando a elicitation e um requestState
 * selado. Nao existe canal de volta no transporte stateless; quem volta com um
 * request novo e o cliente.
 */

import { z } from 'zod';
import { inputRequired, inputResponse } from '@modelcontextprotocol/server';

import {
  MENSAGENS,
  alternativas,
  conflitos,
  criarReserva,
  salas,
  textoPolitica,
  validarPedido,
  versaoPolitica,
} from './dominio.js';
import { codec, selarPedido } from './estado.js';

/**
 * A chave da entrada em `inputRequests`. O servidor a atribui e o cliente
 * devolve exatamente a mesma em `inputResponses`.
 */
const CHAVE_ELICITATION = 'escolha_de_sala';

const MENSAGEM_ELICITATION =
  'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';

const SalaOut = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});

const ConflitoOut = z.object({
  id: z.string(),
  inicio: z.string(),
  fim: z.string(),
  responsavel: z.string(),
});

const DisponibilidadeOut = z.object({
  sala: z.string(),
  livre: z.boolean(),
  conflitos: z.array(ConflitoOut),
});

const ReservaOut = z.object({
  reserva: z.string().nullable(),
  reservado: z.boolean(),
  sala: z.string().nullable(),
  inicio: z.string().nullable(),
  fim: z.string().nullable(),
  responsavel: z.string().nullable(),
  politica: z.string().nullable(),
  motivo: z.string().nullable(),
});

/** Resultado completo: structuredContent e o mesmo JSON em bloco de texto. */
function completo(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/** Erro de execucao da tool: `isError: true` dentro de um resultado complete. */
function erroDeExecucao(mensagem) {
  return { content: [{ type: 'text', text: mensagem }], isError: true };
}

/** Resultado de uma reserva criada, no formato que o contrato define. */
function resultadoDaReserva(reserva) {
  return completo({
    reserva: reserva.id,
    reservado: true,
    sala: reserva.sala,
    inicio: reserva.inicio,
    fim: reserva.fim,
    responsavel: reserva.responsavel,
    politica: versaoPolitica,
    motivo: null,
  });
}

function disponibilidade({ sala, inicioMs, fimMs }) {
  const conflitantes = conflitos(sala, inicioMs, fimMs).map((r) => ({
    id: r.id,
    inicio: r.inicio,
    fim: r.fim,
    responsavel: r.responsavel,
  }));
  return { sala, livre: conflitantes.length === 0, conflitos: conflitantes };
}

/**
 * Reconstroi o pedido. O estado selado sempre vence: os `arguments` que o
 * cliente reenvia no retry sao entrada nao confiavel, entao quando ha
 * requestState valido os valores que valem sao os que foram selados.
 */
function pedidoEfetivo(selado, args) {
  const base = selado ?? args;
  return {
    sala: base.sala,
    inicio: base.inicio,
    fim: base.fim,
    responsavel: base.responsavel,
  };
}

/** Le o enum da elicitation na ordem em que o servidor o emitiu. */
function alternativasDoRequestState(selado, sala, inicioMs, fimMs) {
  if (Array.isArray(selado?.alternativas)) return selado.alternativas;
  return alternativas(sala, inicioMs, fimMs);
}

async function reservarSala(args, ctx) {
  const selado = ctx.mcpReq.requestState();
  const pedido = pedidoEfetivo(selado, args);

  const inicioMs = Date.parse(pedido.inicio);
  const fimMs = Date.parse(pedido.fim);

  const problema = validarPedido({ sala: pedido.sala, inicioMs, fimMs });
  if (problema) return erroDeExecucao(problema);

  const conflitantes = conflitos(pedido.sala, inicioMs, fimMs);

  if (conflitantes.length === 0) {
    return resultadoDaReserva(criarReserva(pedido));
  }

  // Ha conflito. As alternativas vem do estado selado quando ele existe, para
  // que a escolha do cliente seja validada contra a mesma lista oferecida.
  const opcoes = alternativasDoRequestState(selado, pedido.sala, inicioMs, fimMs);

  if (opcoes.length === 0) return erroDeExecucao(MENSAGENS.semAlternativa);

  const resposta = inputResponse(ctx.mcpReq.inputResponses, CHAVE_ELICITATION);

  if (resposta.kind === 'elicit') {
    if (resposta.action === 'accept') {
      const escolhida = resposta.content?.sala;
      if (opcoes.includes(escolhida)) {
        // A sala vem da escolha do cliente; o resto vem do pedido selado.
        return resultadoDaReserva(
          criarReserva({
            sala: escolhida,
            inicio: pedido.inicio,
            fim: pedido.fim,
            responsavel: pedido.responsavel,
          }),
        );
      }
      // Escolha fora do enum: nao tomamos partido, reemimos a elicitation.
    } else {
      // decline ou cancel concluem sem reservar, e isso nao e erro.
      return completo({
        reserva: null,
        reservado: false,
        sala: null,
        inicio: null,
        fim: null,
        responsavel: null,
        politica: null,
        motivo: 'recusado',
      });
    }
  }

  // Precisamos de elicitation. O cliente so pode receber uma se declarou a
  // capability de elicitation em form mode neste request.
  // Nao ha checagem manual de capability aqui, e isso e proposital: o seam do
  // SDK inspeciona o `inputRequired` que estamos devolvendo, ve que ele carrega
  // uma elicitation em form mode e, se o `clientCapabilities` deste request nao
  // a declarar, responde ele mesmo -32021 com `data.requiredCapabilities` e
  // HTTP 400. Lancar o erro daqui seria pior: o handler roda dentro do limite
  // de erro de execucao da tool, entao o erro viraria um `isError: true` com
  // HTTP 200 em vez do erro de protocolo que a spec pede.

  const requestState = await codec.mint(
    selarPedido({ ...pedido, alternativas: opcoes }),
    ctx,
  );

  return inputRequired({
    inputRequests: {
      [CHAVE_ELICITATION]: inputRequired.elicit({
        message: MENSAGEM_ELICITATION,
        requestedSchema: {
          type: 'object',
          properties: {
            sala: {
              type: 'string',
              title: 'Sala',
              description: 'Sala alternativa escolhida',
              enum: opcoes,
            },
          },
          required: ['sala'],
        },
      }),
    },
    requestState,
  });
}

export function registrar(servidor) {
  servidor.registerTool(
    'listar_salas',
    {
      title: 'Listar salas',
      description: 'Lista todas as salas com capacidade e recursos.',
      inputSchema: z.object({}),
      outputSchema: z.object({ salas: z.array(SalaOut) }),
    },
    async () => completo({ salas }),
  );

  servidor.registerTool(
    'consultar_disponibilidade',
    {
      title: 'Consultar disponibilidade',
      description: 'Diz se uma sala esta livre no intervalo, e quais reservas conflitam.',
      inputSchema: z.object({ sala: z.string(), inicio: z.string(), fim: z.string() }),
      outputSchema: DisponibilidadeOut,
    },
    async ({ sala, inicio, fim }) => {
      const inicioMs = Date.parse(inicio);
      const fimMs = Date.parse(fim);

      const problema = validarPedido({ sala, inicioMs, fimMs });
      if (problema) return erroDeExecucao(problema);

      return completo(disponibilidade({ sala, inicioMs, fimMs }));
    },
  );

  servidor.registerTool(
    'reservar_sala',
    {
      title: 'Reservar sala',
      description: 'Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.',
      inputSchema: z.object({
        sala: z.string(),
        inicio: z.string(),
        fim: z.string(),
        responsavel: z.string(),
      }),
      outputSchema: ReservaOut,
    },
    reservarSala,
  );

  servidor.registerResource(
    'politica-de-uso',
    'politica://uso',
    {
      title: 'Politica de uso das salas',
      description: 'As regras de uso das salas de reuniao da Hill Valley Tech.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      if (uri.href !== 'politica://uso') {
        throw new Error(`Resource inexistente: ${uri.href}`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: textoPolitica }],
      };
    },
  );
}

