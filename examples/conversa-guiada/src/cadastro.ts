// #region plugin
import { definePlugin } from '@usebridger/core';

/** `!cadastro` → pergunta o nome, depois a cidade, e confirma. */
export const cadastro = definePlugin({
  name: 'cadastro',
  version: '1.0.0',
  engine: '<1.0.0',
  commands: {
    cadastro: {
      description: 'Pergunta seu nome e sua cidade',
      run: async (c) => {
        await c.reply('Qual é o seu nome?');
        // A próxima mensagem desta pessoa, neste chat, vai para o passo `nome`.
        c.expectReply('nome', { ttlMs: 2 * 60_000 });
      },
    },
  },
  setup(ctx) {
    ctx.conversations.define('nome', async (c) => {
      if (c.text === 'cancelar') return c.reply('Ok, cancelado.');
      await c.reply(`Prazer, ${c.text}! De que cidade você é?`);
      // O estado do fluxo viaja no `data`: o passo seguinte recebe o nome sem guardar nada.
      c.expectReply('cidade', { data: { nome: c.text }, ttlMs: 2 * 60_000 });
    });

    ctx.conversations.define(
      'cidade',
      async (c) => {
        const { nome } = c.data as { nome: string };
        await c.reply(`Cadastro feito: ${nome}, de ${c.text}.`);
      },
      {
        // Roda só se a pessoa sumir: sem ele, a espera venceria em silêncio.
        onExpire: (c) =>
          c.reply('Encerrei o cadastro por falta de resposta. Mande !cadastro para recomeçar.'),
      },
    );
  },
});
// #endregion plugin
