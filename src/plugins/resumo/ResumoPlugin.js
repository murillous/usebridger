import { COMMANDS } from '../../config/constants.js';
import { Logger } from '../../utils/Logger.js';
import { cleanResponseText } from '../../utils/ResponseFormatter.js';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

const RESUMO_PROMPT = (historyText) =>
  `Você é a Luma. Abaixo está o histórico recente desta conversa.\n\n` +
  `Faça um resumo natural e descontraído do que foi discutido, como se estivesse contando pra alguém o que rolou no chat. ` +
  `Seja breve (máximo 5 linhas), use seu jeito de falar e não quebre o personagem.\n\n` +
  `Histórico:\n${historyText}`;

/**
 * Plugin de resumo de conversa.
 * Comandos: !resumo, !resumo <N> (N = número de linhas do histórico, máx 100)
 */
export class ResumoPlugin {
  static commands = [COMMANDS.RESUMO];

  /**
   * @param {object} deps
   * @param {import('../../handlers/LumaHandler.js').LumaHandler} deps.lumaHandler
   */
  constructor({ lumaHandler } = {}) {
    this._lumaHandler = lumaHandler;
  }

  async onCommand(_command, bot) {
    if (!this._lumaHandler?.isConfigured) {
      await bot.reply('❌ IA não configurada para gerar resumo.');
      return;
    }

    const limit = this._parseLimit(bot.body);
    const historyText = this._getLastNLines(bot.jid, limit);

    if (!historyText) {
      await bot.reply('📭 Não tem conversa salva aqui ainda.');
      return;
    }

    await bot.sendPresence('composing');

    try {
      const response = await this._lumaHandler.aiService.generateContent([
        { role: 'user', parts: [{ text: RESUMO_PROMPT(historyText) }] },
      ]);
      const text = cleanResponseText(response.text);
      if (!text) {
        await bot.reply('❌ Não consegui gerar o resumo agora.');
        return;
      }
      await bot.reply(`📋 *Resumo da conversa:*\n\n${text}`);
    } catch (error) {
      Logger.error('❌ Erro no ResumoPlugin:', error);
      await bot.reply('❌ Não consegui gerar o resumo agora.');
    }
  }

  /** @private */
  _parseLimit(body) {
    const match = body?.match(/!resumo\s+(\d+)/i);
    if (!match) return DEFAULT_LIMIT;
    return Math.min(Math.max(parseInt(match[1], 10), 1), MAX_LIMIT);
  }

  /** @private */
  _getLastNLines(jid, n) {
    const text = this._lumaHandler.history.getText(jid);
    if (!text || text === 'Nenhuma conversa anterior.') return null;
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  }
}
