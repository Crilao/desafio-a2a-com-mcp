/**
 * O agente como servidor A2A: Task com identidade, estado e produto.
 *
 * A Task e o mecanismo de estado do A2A, do mesmo jeito que o `requestState` e
 * o do MCP. A ponte entre os dois mora neste arquivo - procure por
 * `TASK_STATE_INPUT_REQUIRED`.
 */

import { randomBytes } from 'node:crypto';

import {
  chamarReserva,
  descobrirFerramentas,
  isInputRequiredResult,
  lerVersaoDaPolitica,
  retomarReserva,
  textoDoResultado,
} from './mcp-host.js';
import { RECUSA, interpretarPedido } from './pedido.js';

const SUBMITTED = 'TASK_STATE_SUBMITTED';
const WORKING = 'TASK_STATE_WORKING';
const INPUT_REQUIRED = 'TASK_STATE_INPUT_REQUIRED';
const COMPLETED = 'TASK_STATE_COMPLETED';
const CANCELED = 'TASK_STATE_CANCELED';
const FAILED = 'TASK_STATE_FAILED';

const TERMINAIS = new Set([COMPLETED, CANCELED, FAILED]);

/** As Tasks vivem em memoria. O estado e por Task, nunca global. */
const tarefas = new Map();

const id = (prefixo) => `${prefixo}-${randomBytes(6).toString('hex')}`;

export class ErroA2A extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function mensagem(role, texto, tarefa) {
  const msg = { messageId: id('msg'), role, parts: [{ text: texto }] };
  if (tarefa) {
    msg.taskId = tarefa.id;
    if (role === 'ROLE_AGENT') msg.contextId = tarefa.contextId;
  }
  return msg;
}

function definirStatus(tarefa, estado, texto) {
  const msg = mensagem('ROLE_AGENT', texto, tarefa);
  tarefa.status = { state: estado, message: msg };
  tarefa.history.push(msg);
}

/**
 * Serializacao por lista branca. O `requestState` guardado na Task e estado
 * interno do agente e nunca pode aparecer numa resposta A2A - por isso nao
 * espalhamos a Task, montamos o objeto campo a campo.
 */
function serializar(tarefa) {
  return {
    id: tarefa.id,
    contextId: tarefa.contextId,
    status: tarefa.status,
    history: tarefa.history,
    artifacts: tarefa.artifacts,
  };
}

function concluir(tarefa, dados) {
  tarefa.status = { state: COMPLETED };
  tarefa.artifacts = [
    {
      artifactId: id('art'),
      name: 'reserva',
      parts: [
        {
          text: JSON.stringify({
            reserva: dados.reserva,
            sala: dados.sala,
            inicio: dados.inicio,
            fim: dados.fim,
            responsavel: dados.responsavel,
            politica: dados.politica,
          }),
        },
      ],
    },
  ];
  definirStatus(tarefa, COMPLETED, `Reserva ${dados.reserva} confirmada na ${dados.sala}.`);
  tarefa.pausa = null;
  return tarefa;
}

function falhar(tarefa, texto) {
  tarefa.pausa = null;
  definirStatus(tarefa, FAILED, texto);
  return tarefa;
}

function repetirPausa(tarefa) {
  definirStatus(tarefa, INPUT_REQUIRED, linhaDasAlternativas(tarefa.pausa.alternativas));
  return tarefa;
}

const linhaDasAlternativas = (alternativas) => `alternativas: ${alternativas.join(', ')}`;

/**
 * Traduz um resultado do MCP para o estado da Task.
 *
 * A PONTE ACONTECE AQUI. Quando o servidor MCP devolve `input_required`, o
 * agente nao responde a elicitation nem trava esperando: ele guarda o
 * `requestState` ligado a ESTA Task, poe a Task em TASK_STATE_INPUT_REQUIRED e
 * devolve a pergunta ao cliente A2A como mensagem de texto. O ciclo so continua
 * quando o cliente mandar um SendMessage novo referenciando a mesma Task.
 */
async function aplicarResultado(tarefa, resultado, traceparent) {
  if (isInputRequiredResult(resultado)) {
    const chave = Object.keys(resultado.inputRequests ?? {})[0];
    const pedido = resultado.inputRequests?.[chave];
    const schemaSala = pedido?.params?.requestedSchema?.properties?.sala ?? {};
    const alternativas = schemaSala.enum ?? (schemaSala.const ? [schemaSala.const] : []);

    // O requestState fica guardado aqui, ligado a esta Task, e daqui so sai de
    // volta para o servidor MCP. Nunca vai para o cliente A2A.
    tarefa.pausa = {
      requestState: resultado.requestState,
      chave,
      alternativas,
      argumentos: tarefa.pedido,
    };

    definirStatus(tarefa, INPUT_REQUIRED, linhaDasAlternativas(alternativas));
    return tarefa;
  }

  if (resultado?.isError) {
    // Erro de execucao da tool vira Task FAILED com a mensagem exata da tool.
    return falhar(tarefa, textoDoResultado(resultado));
  }

  return concluir(tarefa, resultado?.structuredContent ?? {});
}

async function iniciar(tarefa, texto, traceparent) {
  const pedido = interpretarPedido(texto);
  if (!pedido || pedido.tipo !== 'reservar') {
    return falhar(tarefa, `Pedido nao reconhecido: ${texto}`);
  }

  tarefa.pedido = {
    sala: pedido.sala,
    inicio: pedido.inicio,
    fim: pedido.fim,
    responsavel: pedido.responsavel,
  };

  // Descoberta antes da primeira chamada, e a versao da politica lida do resource.
  await descobrirFerramentas(traceparent);
  await lerVersaoDaPolitica(traceparent);

  definirStatus(tarefa, WORKING, 'Reservando...');

  const resultado = await chamarReserva({ ...tarefa.pedido, traceparent });
  return aplicarResultado(tarefa, resultado, traceparent);
}

async function continuar(tarefa, texto, traceparent) {
  const pedido = interpretarPedido(texto);
  const pausa = tarefa.pausa;

  if (!pedido || pedido.tipo !== 'escolha') {
    return repetirPausa(tarefa);
  }

  if (pedido.valor === RECUSA) {
    // Recusar vira `action: decline`. O ciclo MCP fecha do mesmo jeito.
    const resultado = await retomarReserva({
      arguments: pausa.argumentos,
      chave: pausa.chave,
      resposta: { action: 'decline' },
      requestState: pausa.requestState,
      traceparent,
    });

    if (resultado?.isError) return falhar(tarefa, textoDoResultado(resultado));

    tarefa.pausa = null;
    definirStatus(tarefa, CANCELED, 'Reserva recusada pelo cliente.');
    return tarefa;
  }

  // Escolha fora do enum: a Task continua pausada e a lista se repete.
  if (!pausa.alternativas.includes(pedido.valor)) return repetirPausa(tarefa);

  const resultado = await retomarReserva({
    arguments: pausa.argumentos,
    chave: pausa.chave,
    resposta: { action: 'accept', content: { sala: pedido.valor } },
    requestState: pausa.requestState,
    traceparent,
  });

  return aplicarResultado(tarefa, resultado, traceparent);
}

export async function sendMessage(params, traceparent) {
  const recebida = params?.message;
  if (!recebida) throw new ErroA2A(-32602, 'SendMessage exige params.message');

  const texto = (recebida.parts ?? []).map((p) => p?.text ?? '').join(' ').trim();
  const taskId = recebida.taskId;

  if (!taskId) {
    const tarefa = {
      id: id('task'),
      contextId: id('ctx'),
      status: { state: SUBMITTED },
      history: [],
      artifacts: [],
      pausa: null,
      pedido: null,
    };
    tarefas.set(tarefa.id, tarefa);
    tarefa.history.push(mensagem(recebida.role ?? 'ROLE_USER', texto, null));
    tarefa.status = { state: SUBMITTED };
    return serializar(await iniciar(tarefa, texto, traceparent));
  }

  const tarefa = tarefas.get(taskId);
  if (!tarefa) throw new ErroA2A(-32602, `Task inexistente: ${taskId}`);
  if (TERMINAIS.has(tarefa.status.state)) {
    // Estado terminal e definitivo: nao volta a WORKING.
    throw new ErroA2A(-32602, `Task ${taskId} esta em estado terminal ${tarefa.status.state}`);
  }

  tarefa.history.push(mensagem(recebida.role ?? 'ROLE_USER', texto, tarefa));
  return serializar(await continuar(tarefa, texto, traceparent));
}

export function getTask(params) {
  const tarefa = tarefas.get(params?.id);
  if (!tarefa) throw new ErroA2A(-32602, `Task inexistente: ${params?.id}`);
  return serializar(tarefa);
}

/** Card publicado no well-known URI, na forma da v1.0. */
export function agentCard(baseUrl) {
  return {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'reservar-sala',
        name: 'Reservar sala',
        description:
          'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
        tags: ['salas', 'agenda'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: [
          'reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty',
        ],
      },
    ],
  };
}
