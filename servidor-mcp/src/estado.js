/**
 * O `requestState` do MRTR.
 *
 * O requestState sai do servidor dentro do resultado `input_required`, passa
 * pelas maos do cliente e volta no retry. Isso o torna entrada controlada por
 * atacante, entao ele e selado com HMAC-SHA256 pelo codec do SDK: um caractere
 * trocado muda o MAC e o seam rejeita o request com -32602 antes do handler
 * rodar.
 *
 * O payload viaja legivel (o codec assina, nao cifra), e isso e aceito pela
 * spec: o que nao pode e ser adulteravel. Por isso nada de secreto vai aqui -
 * so o pedido original, para que o servidor possa reconstrui-lo sem guardar
 * nada em memoria. E justamente por carregar tudo que ele sobrevive a um
 * restart do processo entre o input_required e o retry.
 */

import { createRequestStateCodec } from '@modelcontextprotocol/server';

const SEGREDO = process.env.REQUEST_STATE_SECRET;

if (!SEGREDO) {
  throw new Error(
    'REQUEST_STATE_SECRET nao definida. Gere uma com\n' +
      '  python3 -c "import secrets; print(secrets.token_hex(32))"\n' +
      'e exporte antes de subir o servidor. Consulte o README.',
  );
}

if (Buffer.byteLength(SEGREDO, 'utf8') < 32) {
  throw new Error(
    `REQUEST_STATE_SECRET tem ${Buffer.byteLength(SEGREDO, 'utf8')} bytes; a spec exige no minimo 32.`,
  );
}

/** Validade do requestState, dentro da janela de 5 a 30 minutos da spec. */
export const TTL_SEGUNDOS = 900;

export const codec = createRequestStateCodec({ key: SEGREDO, ttlSeconds: TTL_SEGUNDOS });

/**
 * Tudo que o servidor precisa para reconstruir o pedido original no retry.
 * `alternativas` viaja junto para que a escolha do cliente seja validada
 * contra a mesma lista que foi oferecida.
 */
export function selarPedido({ sala, inicio, fim, responsavel, alternativas }) {
  return { sala, inicio, fim, responsavel, alternativas };
}
