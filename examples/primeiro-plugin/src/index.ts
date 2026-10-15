import { bold, definePlugin, fmt, type PluginDefinition } from '@usebridger/core';

// #region plugin
/** `!ola` → cumprimenta quem chamou pelo nome, com uma reação onde a plataforma tem. */
export const ola: PluginDefinition = definePlugin({
  name: 'ola',
  version: '0.1.0',
  engine: '<1.0.0',
  commands: {
    ola: {
      description: 'Cumprimenta quem chamou',
      run: async (c, { capabilities }) => {
        // Reação é extra: onde o transport não tem, o plugin segue só com o texto.
        if (capabilities.has('reactions')) await c.react('👋');
        // `fmt` e `bold` viram o negrito de cada plataforma (`*a*`, `**a**`, `<b>a</b>`).
        return fmt`Olá, ${bold(c.message.sender.name ?? 'pessoa')}!`;
      },
    },
  },
});
// #endregion plugin
