// #region plugin
import { createHash, timingSafeEqual } from 'node:crypto';
import { definePlugin, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';

/** `POST /plugins/avisos` com `Authorization: Bearer <token>` → manda o corpo da requisição no chat. */
export const avisos = definePlugin({
  name: 'avisos',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({
    // Sem default: o bot não sobe sem saber para onde mandar.
    chat: z.string().min(1),
    // `secret` tira o valor do log e do `describe`, e recusa defini-lo por override.
    token: secret(z.string().min(16)),
    prefixo: z.string().default('📢'),
  }),
  setup(ctx) {
    ctx.http.route('POST', '/', async (req) => {
      if (!mesmoTexto(req.headers.get('authorization') ?? '', `Bearer ${ctx.config.token}`)) {
        return new Response('não autorizado', { status: 401 });
      }
      await ctx.send.send(ctx.config.chat, `${ctx.config.prefixo} ${await req.text()}`);
      return new Response(null, { status: 204 });
    });
  },
});

// Comparação em tempo constante: um `!==` vaza pelo tempo de resposta quantos caracteres do token
// o atacante já acertou. O hash iguala os tamanhos, que o `timingSafeEqual` exige.
function mesmoTexto(a: string, b: string): boolean {
  const hash = (texto: string) => createHash('sha256').update(texto).digest();
  return timingSafeEqual(hash(a), hash(b));
}
// #endregion plugin
