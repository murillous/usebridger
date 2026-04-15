import { Logger } from '../utils/Logger.js';
import { BaileysAdapter } from '../adapters/BaileysAdapter.js';
import { MessageHandler } from '../handlers/MessageHandler.js';

/**
 * Recebe o evento `messages.upsert` do Baileys, cria um BaileysAdapter
 * para cada mensagem e delega o processamento ao MessageHandler.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {{ type: string, messages: object[] }} m - Payload do evento messages.upsert
 */
export async function routeMessages(sock, m) {
  try {
    if (m.type !== 'notify') return;

    for (const message of m.messages) {
      if (!message.message) continue;
      const botAdapter = new BaileysAdapter(sock, message);
      await MessageHandler.process(botAdapter);
    }
  } catch (error) {
    Logger.error('Erro ao processar mensagem:', error);
  }
}
