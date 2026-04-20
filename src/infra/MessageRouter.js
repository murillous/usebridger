import { Logger } from '../utils/Logger.js';
import { BaileysAdapter } from '../adapters/BaileysAdapter.js';
import { MessageHandler } from '../handlers/MessageHandler.js';
import { JidQueue } from './JidQueue.js';

/**
 * Fila global por JID: mensagens do mesmo chat são serializadas,
 * chats diferentes são processados em paralelo.
 */
const queue = new JidQueue();

/**
 * Recebe o evento `messages.upsert` do Baileys, cria um BaileysAdapter
 * para cada mensagem e delega o processamento ao MessageHandler via JidQueue.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {{ type: string, messages: object[] }} m - Payload do evento messages.upsert
 */
export async function routeMessages(sock, m) {
  try {
    if (m.type !== 'notify') return;

    const pending = [];
    for (const message of m.messages) {
      if (!message.message) continue;
      const botAdapter = new BaileysAdapter(sock, message);
      pending.push(
        queue.enqueue(botAdapter.jid, () => MessageHandler.process(botAdapter)),
      );
    }

    await Promise.all(pending);
  } catch (error) {
    Logger.error('Erro ao processar mensagem:', error);
  }
}
