import { COMMANDS, CONFIG, MESSAGES, MENUS } from "../config/constants.js";
import { Logger } from "../utils/Logger.js";
import { MediaProcessor } from "./MediaProcessor.js";
import { GroupManager } from "../managers/GroupManager.js";
import { BlacklistManager } from "../managers/BlacklistManager.js";
import { LumaHandler } from "./LumaHandler.js";
import { LUMA_CONFIG } from "../config/lumaConfig.js";
import { DatabaseService } from "../services/Database.js";
import { PersonalityManager } from "../managers/PersonalityManager.js";
import dotenv from "dotenv";

dotenv.config();

export class MessageHandler {
  static lumaHandler = new LumaHandler();

  static async process(bot) {
    const text = bot.body;
    const jid = bot.jid;

    if (CONFIG.IGNORE_SELF && bot.isFromMe) return;

    if (bot.isGroup && BlacklistManager.isBlocked(jid)) {
      const ownerNumber = process.env.OWNER_NUMBER?.replace(/\D/g, "");
      const senderNumber = bot.isFromMe
        ? ownerNumber
        : await bot.getSenderNumber();

      if (senderNumber !== ownerNumber) return;
    }

    if (text) {
      if (await this.handleMenuReply(bot, text)) return;
      if (await this.handleAdminCommands(bot, text)) return;

      const command = this.detectCommand(text);

      if (command) {
        switch (command) {
          case COMMANDS.HELP:
            return await bot.sendText(MENUS.HELP_TEXT);
          case COMMANDS.PERSONA:
            return await this.sendPersonalityMenu(bot);
          case COMMANDS.LUMA_STATS:
          case COMMANDS.LUMA_STATS_SHORT:
            return await this.sendStats(bot);
          case COMMANDS.LUMA_CLEAR:
          case COMMANDS.LUMA_CLEAR_SHORT:
          case COMMANDS.LUMA_CLEAR_ALT:
            this.lumaHandler.clearHistory(jid);
            return await bot.reply("🗑️ Memória da Luma limpa nesta conversa!");
          case COMMANDS.MY_NUMBER:
            const senderNum = await bot.getSenderNumber();
            const chatId = bot.jid;
            return await bot.reply(
              `📱 *Informações de ID*\n\n👤 *Seu Número:* ${senderNum}\n💬 *ID deste Chat:* ${chatId}`,
            );
          case COMMANDS.STICKER:
          case COMMANDS.STICKER_SHORT:
            return await this.handleStickerCommand(bot, text);
          case COMMANDS.IMAGE:
          case COMMANDS.IMAGE_SHORT:
            return await this.handleImageCommand(bot);
          case COMMANDS.GIF:
          case COMMANDS.GIF_SHORT:
            return await this.handleGifCommand(bot);
          case COMMANDS.EVERYONE:
            if (bot.isGroup) {
              await GroupManager.mentionEveryone(bot.raw, bot.socket);
            } else {
              await bot.reply("⚠️ Este comando só funciona em grupos!");
            }
            return;
        }
      }
    }

    if (this.lumaHandler.isReplyToLuma(bot.raw)) {
      return await this.handleLumaCommand(bot, true);
    }

    if (text && LumaHandler.isTriggered(text)) {
      return await this.handleLumaCommand(bot, false);
    }
  }

  static async handleLumaCommand(bot, isReply = false) {
    try {
      const senderName = bot.senderName;

      let userMessage = isReply
        ? bot.body
        : this.lumaHandler.extractUserMessage(bot.body);

      if (!userMessage && !bot.hasVisualContent) {
        const bored = this.lumaHandler.getRandomBoredResponse();
        const sent = await bot.reply(bored);
        if (sent?.key?.id)
          this.lumaHandler.saveLastBotMessage(bot.jid, sent.key.id);
        return;
      }

      if (!userMessage && bot.hasVisualContent) {
        userMessage = "O que você acha dessa imagem?";
      }

      await bot.sendPresence("composing");
      await this.randomDelay();

      const responseText = await this.lumaHandler.generateResponse(
        userMessage,
        bot.jid,
        bot.raw,
        bot.socket,
        senderName,
      );

      const sentMessage = await bot.reply(responseText);

      if (sentMessage?.key?.id) {
        this.lumaHandler.saveLastBotMessage(bot.jid, sentMessage.key.id);
      }
    } catch (error) {
      Logger.error("❌ Erro no comando da Luma:", error);
      await bot.reply("Num deu certo não. Bugou aqui, tenta depois.");
    }
  }

  static async handleStickerCommand(bot, text) {
    const url = this.extractUrl(text);
    if (url) {
      await MediaProcessor.processUrlToSticker(url, bot.socket, bot.raw);
      this.incrementMediaStats("stickers_created");
      return;
    }
    if (bot.hasMedia) {
      await MediaProcessor.processToSticker(bot.raw, bot.socket);
      this.incrementMediaStats("stickers_created");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasMedia) {
      await MediaProcessor.processToSticker(quoted.raw, bot.socket, bot.jid);
      this.incrementMediaStats("stickers_created");
    } else {
      await bot.reply(MESSAGES.REPLY_MEDIA_STICKER);
    }
  }

  static async handleImageCommand(bot) {
    if (bot.hasSticker) {
      await MediaProcessor.processStickerToImage(bot.raw, bot.socket);
      this.incrementMediaStats("images_created");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasSticker) {
      await MediaProcessor.processStickerToImage(
        quoted.raw,
        bot.socket,
        bot.jid,
      );
      this.incrementMediaStats("images_created");
    } else {
      await bot.reply(MESSAGES.REPLY_STICKER_IMAGE);
    }
  }

  static async handleGifCommand(bot) {
    if (bot.hasSticker) {
      await MediaProcessor.processStickerToGif(bot.raw, bot.socket);
      this.incrementMediaStats("gifs_created");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasSticker) {
      await MediaProcessor.processStickerToGif(quoted.raw, bot.socket, bot.jid);
      this.incrementMediaStats("gifs_created");
    } else {
      await bot.reply(MESSAGES.REPLY_STICKER_GIF);
    }
  }

  static async handleAdminCommands(bot, text) {
    const lower = text.toLowerCase();
    const ownerNumber = process.env.OWNER_NUMBER?.replace(/\D/g, "");
    const senderNumber = bot.isFromMe
      ? ownerNumber
      : await bot.getSenderNumber();

    if (senderNumber !== ownerNumber) return false;

    if (lower.startsWith("!blacklist")) {
      const parts = lower.split(" ");
      const action = parts[1];

      if (action === "add") {
        if (!bot.isGroup) return bot.reply("⚠️ Use isso dentro do grupo.");
        if (BlacklistManager.add(bot.jid))
          await bot.reply("🚫 Grupo bloqueado!");
        else await bot.reply("❌ Erro ao adicionar.");
        return true;
      }
      if (action === "remove") {
        if (BlacklistManager.remove(bot.jid))
          await bot.reply("✅ Grupo desbloqueado!");
        else await bot.reply("⚠️ Não estava bloqueado.");
        return true;
      }
      if (action === "list") {
        const list = BlacklistManager.list();
        await bot.reply(
          list.length ? `📋 *Blacklist:*\n${list.join("\n")}` : "📋 Vazia.",
        );
        return true;
      }
      if (action === "clear") {
        BlacklistManager.clear();
        await bot.reply("🗑️ Blacklist zerada!");
        return true;
      }
      await bot.reply("Use: !blacklist <add|remove|list|clear>");
      return true;
    }
    return false;
  }

  static async sendStats(bot) {
    const dbStats = DatabaseService.getMetrics();

    const memoryStats = this.lumaHandler.getStats();

    let statsText =
      `📊 *Estatísticas Globais da Luma*\n\n` +
      `🧠 *Inteligência Artificial:*\n` +
      `• Respostas Geradas: ${dbStats.ai_responses || 0}\n` +
      `• Conversas Ativas (RAM): ${memoryStats.totalConversations}\n`;

    statsText +=
      `\n🎨 *Mídia Gerada:*\n` +
      `• Figurinhas: ${dbStats.stickers_created || 0}\n` +
      `• Imagens: ${dbStats.images_created || 0}\n` +
      `• GIFs: ${dbStats.gifs_created || 0}\n\n` +
      `📈 *Total de Interações:* ${dbStats.total_messages || 0}`;

    await bot.sendText(statsText);
  }

  static async sendPersonalityMenu(bot) {
    const list = PersonalityManager.getList();
    const currentName = PersonalityManager.getActiveName(bot.jid);

    let text = `${MENUS.PERSONALITY.HEADER}\n`;
    text += `🔹 Atual neste chat: ${currentName}\n\n`;

    list.forEach((p, index) => {
      const isDefault =
        p.key === LUMA_CONFIG.DEFAULT_PERSONALITY ? " ⭐ (Padrão)" : "";
      text += `p${index + 1} - ${p.name}${isDefault}\n${p.desc}\n\n`;
    });

    text += MENUS.PERSONALITY.FOOTER;
    await bot.sendText(text);
  }

  static async handleMenuReply(bot, text) {
    const quotedText = bot.quotedText;
    if (!quotedText) return false;
    if (quotedText.includes(MENUS.PERSONALITY.HEADER.split("\n")[0])) {
      const list = PersonalityManager.getList();
      const num = parseInt(text.trim().toLowerCase().replace("p", ""));
      const index = !isNaN(num) && num > 0 ? num - 1 : -1;
      if (index >= 0 && index < list.length) {
        PersonalityManager.setPersonality(bot.jid, list[index].key);
        await bot.reply(`${MENUS.MSGS.PERSONA_CHANGED}*${list[index].name}*`);
      } else {
        await bot.reply(MENUS.MSGS.INVALID_OPT);
      }
      return true;
    }
    return false;
  }

  static detectCommand(text) {
    const lower = text.toLowerCase();
    if (lower === COMMANDS.MY_NUMBER) return COMMANDS.MY_NUMBER;
    if (lower.includes(COMMANDS.LUMA_CLEAR)) return COMMANDS.LUMA_CLEAR;
    if (lower.includes("!clear")) return COMMANDS.LUMA_CLEAR_ALT;
    if (lower.includes(COMMANDS.LUMA_STATS)) return COMMANDS.LUMA_STATS;
    if (lower.includes(COMMANDS.LUMA_STATS_SHORT)) return COMMANDS.LUMA_STATS;
    if (lower.includes(COMMANDS.STICKER)) return COMMANDS.STICKER;
    if (lower.includes(COMMANDS.STICKER_SHORT)) return COMMANDS.STICKER;
    if (lower.includes(COMMANDS.IMAGE)) return COMMANDS.IMAGE;
    if (lower.includes(COMMANDS.IMAGE_SHORT)) return COMMANDS.IMAGE;
    if (lower.includes(COMMANDS.GIF)) return COMMANDS.GIF;
    if (lower.includes(COMMANDS.GIF_SHORT)) return COMMANDS.GIF;
    if (lower.includes(COMMANDS.EVERYONE.toLowerCase()) || lower === "@todos")
      return COMMANDS.EVERYONE;
    if (lower.includes(COMMANDS.HELP) || lower === "!menu")
      return COMMANDS.HELP;
    if (lower.startsWith(COMMANDS.PERSONA)) return COMMANDS.PERSONA;
    return null;
  }

  static extractUrl(text) {
    if (!text) return null;
    const match = text.match(/(https?:\/\/[^\s]+)/g);
    return match ? match[0] : null;
  }

  static incrementMediaStats(type) {
    DatabaseService.incrementMetric(type);
    DatabaseService.incrementMetric("total_messages");
  }

  static async randomDelay() {
    const { min, max } = LUMA_CONFIG.TECHNICAL.thinkingDelay;
    await new Promise((resolve) =>
      setTimeout(resolve, min + Math.random() * (max - min)),
    );
  }

  // Legacy
  static getMessageType(message) {
    if (message.message?.imageMessage)
      return message.message.imageMessage.mimetype?.includes("gif")
        ? "gif"
        : "image";
    if (message.message?.videoMessage)
      return message.message.videoMessage.gifPlayback ? "gif" : "video";
    return "image";
  }
  static async sendMessage(sock, jid, text) {
    try {
      if (sock) await sock.sendMessage(jid, { text });
    } catch (error) {
      Logger.error("Erro ao enviar:", error);
    }
  }
}
