/**
 * Dominio da Central de Salas: leitura dos dados do starter, validacao da
 * politica de uso, deteccao de conflito e calculo das alternativas.
 *
 * Este modulo e a unica fonte de verdade de regra de negocio. O agente A2A nao
 * decide nada disto: ele so traduz protocolo.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DADOS = join(RAIZ, 'dados');

const ler = (nome) => readFileSync(join(DADOS, nome), 'utf8');

export const salas = JSON.parse(ler('salas.json'));
export const textoPolitica = ler('politica-de-uso.md');

/** A primeira linha da politica declara a versao: `versao: 2026-11-01`. */
export const versaoPolitica = (() => {
  const primeira = textoPolitica.split('\n', 1)[0];
  const valor = primeira.slice(primeira.indexOf(':') + 1).trim();
  if (!valor) throw new Error('politica-de-uso.md nao declara a versao na primeira linha');
  return valor;
})();

/**
 * As reservas vivem em memoria e sao visiveis para os requests seguintes do
 * mesmo processo. Nao precisam sobreviver a um restart - o unico estado que
 * precisa e o requestState, que viaja selado dentro dele mesmo.
 */
export const reservas = JSON.parse(ler('reservas.json'));

const maiorNumero = reservas.reduce((maior, r) => {
  const n = Number.parseInt(String(r.id).replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n > maior ? n : maior;
}, 0);
let proximoNumero = maiorNumero + 1;

function novoIdReserva() {
  return `res-${String(proximoNumero++).padStart(4, '0')}`;
}

/** Mensagens exatas exigidas pelo enunciado. Nao alterar o texto. */
export const MENSAGENS = {
  sala: (id) => `Sala inexistente: ${id}`,
  janela: 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00',
  duracao: 'Duracao acima do limite: a politica permite no maximo 2 horas',
  intervalo: 'Intervalo invalido: fim deve ser posterior a inicio',
  semAlternativa: 'Sem alternativas disponiveis no intervalo',
};

/** A janela de uso da politica, em minutos desde a meia-noite de Sao Paulo. */
const ABERTURA = 8 * 60;
const FECHAMENTO = 20 * 60;
const DUAS_HORAS_MS = 2 * 60 * 60 * 1000;
const OFFSET_SAO_PAULO_MS = -3 * 60 * 60 * 1000;

/**
 * Minutos desde a meia-noite no relogio de Sao Paulo. Deslocamos o instante
 * pelo offset fixo (-03:00) e lemos os campos UTC, o que devolve a hora de
 * parede paulistana independentemente do offset que veio no ISO 8601.
 */
function minutosEmSaoPaulo(ms) {
  const d = new Date(ms + OFFSET_SAO_PAULO_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function salaPorId(id) {
  return salas.find((s) => s.id === id);
}

/**
 * Valida sala e politica na ordem que o enunciado define. Devolve a mensagem
 * de erro, ou `null` quando o pedido e valido.
 */
export function validarPedido({ sala, inicioMs, fimMs }) {
  if (!salaPorId(sala)) return MENSAGENS.sala(sala);

  // Instante que o Date.parse nao entendeu: sem isto as comparacoes abaixo
  // seriam todas falsas e o pedido passaria como valido.
  if (!Number.isFinite(inicioMs) || !Number.isFinite(fimMs)) return MENSAGENS.intervalo;

  const inicioMin = minutosEmSaoPaulo(inicioMs);
  const fimMin = minutosEmSaoPaulo(fimMs);
  if (inicioMin < ABERTURA || inicioMin > FECHAMENTO || fimMin < ABERTURA || fimMin > FECHAMENTO) {
    return MENSAGENS.janela;
  }

  if (fimMs - inicioMs > DUAS_HORAS_MS) return MENSAGENS.duracao;

  if (fimMs <= inicioMs) return MENSAGENS.intervalo;

  return null;
}

/** Reservas da sala que se sobrepoem ao intervalo. Sobreposicao meio-aberta. */
export function conflitos(sala, inicioMs, fimMs) {
  return reservas.filter(
    (r) => r.sala === sala && inicioMs < Date.parse(r.fim) && Date.parse(r.inicio) < fimMs,
  );
}

/**
 * Salas livres no intervalo com capacidade maior ou igual a da sala pedida,
 * no maximo tres, ordenadas por capacidade crescente e, em empate, por id.
 */
export function alternativas(salaPedida, inicioMs, fimMs) {
  const pedida = salaPorId(salaPedida);
  if (!pedida) return [];

  return salas
    .filter((s) => s.id !== salaPedida)
    .filter((s) => s.capacidade >= pedida.capacidade)
    .filter((s) => conflitos(s.id, inicioMs, fimMs).length === 0)
    .sort((a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 3)
    .map((s) => s.id);
}

/** Cria a reserva e devolve o registro criado. */
export function criarReserva({ sala, inicio, fim, responsavel }) {
  const reserva = { id: novoIdReserva(), sala, inicio, fim, responsavel };
  reservas.push(reserva);
  return reserva;
}
