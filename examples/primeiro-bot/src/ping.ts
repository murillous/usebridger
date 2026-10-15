import { definePlugin } from '@usebridger/core';

// #region plugin-ping
// Um plugin é um objeto: nome, versão, a faixa do core que ele aceita e o que ele oferece.
export const ping = definePlugin({
  name: 'ping',
  version: '1.0.0',
  engine: '<1.0.0',
  commands: {
    // `!ping` → o que o `run` devolver vira a resposta no mesmo chat.
    ping: { description: 'Responde pong', run: () => 'pong' },
  },
});
// #endregion plugin-ping
