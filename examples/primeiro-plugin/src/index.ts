// #region plugin
import { bold, definePlugin, defineResource, fmt, type PluginDefinition } from '@usebridger/core';
import { z } from '@usebridger/core/zod';

// `type`, não `interface`: o documento do storage precisa de assinatura de índice JSON.
type Saudacao = { pessoa: string; vezes: number };

/**
 * `!ola` → cumprimenta quem chamou pelo nome, com uma reação onde a plataforma tem. Quantas vezes
 * cada pessoa foi cumprimentada sai na API em `GET /api/resources/ola/saudacoes`.
 */
export const ola: PluginDefinition = definePlugin({
  name: 'ola',
  version: '0.1.0',
  engine: '<1.0.0',
  // `commands` já exige `send.text`. Em `requires` vai só o que o plugin não funciona sem.
  commands: {
    ola: {
      description: 'Cumprimenta quem chamou',
      run: async (c, { capabilities, storage }) => {
        // Reação é extra: onde o transport não tem, o plugin segue só com o texto.
        if (capabilities.has('reactions')) await c.react('👋');
        const pessoa = c.message.sender.name ?? 'pessoa';
        // Atômico; na primeira vez o `insert` cria o documento já somado.
        await storage
          .collection<Saudacao>('saudacoes')
          .increment({ pessoa }, 'vezes', 1, { insert: { pessoa, vezes: 0 } });
        // `fmt` e `bold` viram o negrito de cada plataforma (`*a*`, `**a**`, `<b>a</b>`).
        return fmt`Olá, ${bold(pessoa)}!`;
      },
    },
  },
  setup(ctx) {
    const saudacoes = ctx.storage.collection<Saudacao>('saudacoes');
    // Dados na API do core, sem UI: o dashboard (ou outro app) desenha a tela pelo schema. Sem
    // `http` no `createBot`, o recurso só fica no ponto, sem rota.
    ctx.services.contribute(
      'api.resources',
      defineResource({
        id: 'saudacoes',
        schema: z.object({ id: z.string(), pessoa: z.string(), vezes: z.number() }),
        permissions: { read: 'ola.read' },
        list: async ({ cursor, limit }) => {
          // O cursor é o deslocamento da próxima página; o cliente só o devolve.
          const offset = cursor === undefined ? 0 : Number(cursor);
          const items = await saudacoes.find({ orderBy: 'pessoa', offset, limit: limit + 1 });
          return {
            items: items.slice(0, limit),
            cursor: items.length > limit ? String(offset + limit) : undefined,
          };
        },
      }),
    );
  },
});
// #endregion plugin
