// #region plugin-pareamento
import { definePlugin } from '@usebridger/core';
import qrcode from 'qrcode-terminal';

// O transport avisa o pareamento pelo barramento de eventos; quem mostra ao usuário é um plugin.
export const pareamento = definePlugin({
  name: 'pareamento',
  version: '1.0.0',
  engine: '<1.0.0',
  on: {
    // Pareamento por QR: WhatsApp → Aparelhos conectados → Conectar um aparelho.
    'connection.qr': ({ payload }) => qrcode.generate(payload.qr, { small: true }),
    // Pareamento por código (quando o `phone` é informado): digite-o no celular em
    // Aparelhos conectados → Conectar com número de telefone.
    'connection.pairing-code': ({ payload }) =>
      console.log(`Código de pareamento: ${payload.code}`),
  },
});
// #endregion plugin-pareamento
