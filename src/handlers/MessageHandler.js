import { CONFIG, MENUS } from "../config/constants.js";
import { Logger } from "../utils/Logger.js";
import { LumaHandler } from "./LumaHandler.js";
import { AudioTranscriber } from "../services/AudioTranscriber.js";
import { SpontaneousHandler } from "./SpontaneousHandler.js";
import { PersonalityManager } from "../managers/PersonalityManager.js";
import { CommandRouter } from "../core/services/CommandRouter.js";
import { LUMA_CONFIG } from "../config/lumaConfig.js";
import { env } from "../config/env.js";

/**
 * Orquestrador central de mensagens.
 * Coordena: easter eggs → menu → comandos → áudio → Luma → espontâneo.
 * Toda lógica de negócio vive nos serviços (CommandRouter, LumaHandler, etc.).
 */
export class MessageHandler {
  static lumaHandler = new LumaHandler();
  static _audioTranscriber = null;
  static _groupBuffer = new Map();

  static get audioTranscriber() {
    if (!this._audioTranscriber && env.GEMINI_API_KEY) {
      this._audioTranscriber = new AudioTranscriber(env.GEMINI_API_KEY);
    }
    return this._audioTranscriber;
  }

  /** Ponto de entrada: uma mensagem recebida pelo bot. */
  static async process(bot) {
    if (CONFIG.IGNORE_SELF && bot.isFromMe) return;

    if (bot.isGroup && !bot.isFromMe) {
      SpontaneousHandler.trackActivity(bot.jid);
      if (bot.body) this._addToGroupBuffer(bot.jid, bot.body, bot.senderName);
    }

    await this._handleEasterEggs(bot);

    if (bot.body && await this._handleMenuReply(bot)) return;

    const command = CommandRouter.detect(bot.body);
    if (command) {
      const handled = await CommandRouter.dispatch(bot, command, { lumaHandler: this.lumaHandler });
      if (handled) return;
    }

    const isPrivate    = !bot.isGroup;
    const isReplyToBot = bot.isRepliedToMe;
    const isTriggered  = bot.body && LumaHandler.isTriggered(bot.body);
    const groupContext = bot.isGroup ? this._getGroupContext(bot.jid) : "";

    if (bot.hasAudio && (isPrivate || isReplyToBot)) {
      return await this.lumaHandler.handleAudio(bot, this.audioTranscriber, groupContext);
    }
    if (bot.quotedHasAudio && (isPrivate || isReplyToBot || isTriggered)) {
      return await this.lumaHandler.handleAudio(bot, this.audioTranscriber, groupContext);
    }

    if (isPrivate || isReplyToBot || isTriggered) {
      return await this.lumaHandler.handle(bot, isReplyToBot, groupContext);
    }

    if (bot.isGroup && (bot.body || bot.hasVisualContent)) {
      await SpontaneousHandler.handle(bot, this.lumaHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  static _addToGroupBuffer(jid, text, senderName) {
    const { groupContextSize } = LUMA_CONFIG.TECHNICAL;
    const buf = this._groupBuffer.get(jid) ?? [];
    buf.push({ name: senderName, text });
    if (buf.length > groupContextSize) buf.shift();
    this._groupBuffer.set(jid, buf);
  }

  static _getGroupContext(jid) {
    const buf = this._groupBuffer.get(jid);
    if (!buf?.length) return "";
    return buf.map((m) => `${m.name}: ${m.text}`).join("\n");
  }

  static async _handleMenuReply(bot) {
    const quotedText = bot.quotedText;
    if (!quotedText?.includes(MENUS.PERSONALITY.HEADER.split("\n")[0])) return false;

    const list  = PersonalityManager.getList();
    const num   = parseInt(bot.body.trim().toLowerCase().replace("p", ""));
    const index = !isNaN(num) && num > 0 ? num - 1 : -1;

    if (index >= 0 && index < list.length) {
      PersonalityManager.setPersonality(bot.jid, list[index].key);
      await bot.reply(`${MENUS.MSGS.PERSONA_CHANGED}*${list[index].name}*`);
    } else {
      await bot.reply(MENUS.MSGS.INVALID_OPT);
    }
    return true;
  }

  static async _handleEasterEggs(bot) {
    await this._groupJoke(bot, "beta", "559884323093", "120363203644262523@g.us");
  }

  static async _groupJoke(bot, triggerWord, targetNumber, targetGroup) {
    const { body: text, jid } = bot;
    if (!bot.isGroup || jid !== targetGroup || !text) return;

    const matches = text.match(new RegExp(triggerWord, "gi"));
    if (matches?.length > 0) {
      await bot.socket.sendMessage(jid, {
        text: Array(matches.length).fill(`@${targetNumber}`).join(" "),
        mentions: [`${targetNumber}@s.whatsapp.net`],
      });
    }
  }
}
