/**
 * O pedido chega em formato fixo, nao em linguagem natural, e a resposta a
 * pausa tambem. Nao ha LLM em lugar nenhum do caminho de execucao: dado o
 * mesmo pedido, o agente produz sempre o mesmo resultado.
 */

const CAMPOS_RESERVA = ['sala', 'inicio', 'fim', 'responsavel'];

/**
 * `reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>`
 * ou `escolha=<id da sala>` / `escolha=recusar`.
 */
export function interpretarPedido(texto) {
  const limpo = String(texto ?? '').trim();

  if (limpo.startsWith('reservar')) {
    const campos = {};
    for (const parte of limpo.split(/\s+/).slice(1)) {
      const separador = parte.indexOf('=');
      if (separador > 0) campos[parte.slice(0, separador)] = parte.slice(separador + 1);
    }
    if (CAMPOS_RESERVA.every((campo) => campos[campo])) {
      return { tipo: 'reservar', ...campos };
    }
    return null;
  }

  const escolha = /^escolha=(.+)$/.exec(limpo);
  if (escolha) return { tipo: 'escolha', valor: escolha[1].trim() };

  return null;
}

export const RECUSA = 'recusar';
