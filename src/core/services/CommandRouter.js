import { COMMANDS, MENUS, MESSAGES } from "../../config/constants.js";
import { Logger } from "../../utils/Logger.js";
import { MediaProcessor } from "../../handlers/MediaProcessor.js";
import { GroupManager } from "../../managers/GroupManager.js";
import { VideoDownloader } from "../../services/VideoDownloader.js";
import { VideoConverter } from "../../processors/VideoConverter.js";
import { DatabaseService } from "../../services/Database.js";
import { PersonalityManager } from "../../managers/PersonalityManager.js";
import { LUMA_CONFIG } from "../../config/lumaConfig.js";
import { extractUrl } from "../../utils/MessageUtils.js";
import fs from "fs";

/**
 * Roteador de comandos explícitos (prefixados com `!` ou `@`).
 *
 * Responsabilidades:
 * - Detectar qual comando está presente em um texto
 * - Despachar para o handler correto
 *
 * Cada handler recebe apenas o `bot` (BaileysAdapter) e recursos extras via
 * parâmetros — sem acoplar ao MessageHandler.
 */
export class CommandRouter {
  /**
   * Detecta o comando presente no texto.
   * @param {string|null} text
   * @returns {string|null} Uma das constantes COMMANDS ou null
   */
  static detect(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    if (lower === COMMANDS.MY_NUMBER)            return COMMANDS.MY_NUMBER;
    if (lower === COMMANDS.LUMA_CLEAR_SHORT)     return COMMANDS.LUMA_CLEAR;
    if (lower.includes(COMMANDS.LUMA_CLEAR))     return COMMANDS.LUMA_CLEAR;
    if (lower.includes("!clear"))                return COMMANDS.LUMA_CLEAR_ALT;
    if (lower.includes(COMMANDS.LUMA_STATS))     return COMMANDS.LUMA_STATS;
    if (lower.includes(COMMANDS.LUMA_STATS_SHORT)) return COMMANDS.LUMA_STATS;
    if (lower.includes(COMMANDS.STICKER))        return COMMANDS.STICKER;
    if (lower.includes(COMMANDS.STICKER_SHORT))  return COMMANDS.STICKER;
    if (lower.includes(COMMANDS.IMAGE))          return COMMANDS.IMAGE;
    if (lower.includes(COMMANDS.IMAGE_SHORT))    return COMMANDS.IMAGE;
    if (lower.includes(COMMANDS.GIF))            return COMMANDS.GIF;
    if (lower.includes(COMMANDS.GIF_SHORT))      return COMMANDS.GIF;
    if (lower.includes(COMMANDS.EVERYONE.toLowerCase()) || lower === "@todos") return COMMANDS.EVERYONE;
    if (lower.includes(COMMANDS.HELP) || lower === "!menu") return COMMANDS.HELP;
    if (lower.startsWith(COMMANDS.PERSONA))      return COMMANDS.PERSONA;
    if (lower.startsWith(COMMANDS.DOWNLOAD))     return COMMANDS.DOWNLOAD;
    if (lower.startsWith(COMMANDS.DOWNLOAD_SHORT)) return COMMANDS.DOWNLOAD;

    return null;
  }

  /**
   * Executa o handler do comando detectado.
   *
   * @param {object} bot - BaileysAdapter
   * @param {string} command - Constante COMMANDS retornada por detect()
   * @param {object} [deps] - Dependências opcionais
   * @param {object} [deps.lumaHandler] - Instância do LumaHandler (para clear/stats)
   * @returns {Promise<boolean>} true se o comando foi tratado
   */
  static async dispatch(bot, command, { lumaHandler } = {}) {
    switch (command) {
      case COMMANDS.HELP:
        await bot.sendText(MENUS.HELP_TEXT);
        return true;

      case COMMANDS.PERSONA:
        await CommandRouter._sendPersonalityMenu(bot);
        return true;

      case COMMANDS.LUMA_STATS:
      case COMMANDS.LUMA_STATS_SHORT:
        await CommandRouter._sendStats(bot, lumaHandler);
        return true;

      case COMMANDS.LUMA_CLEAR:
      case COMMANDS.LUMA_CLEAR_SHORT:
      case COMMANDS.LUMA_CLEAR_ALT:
        lumaHandler?.clearHistory(bot.jid);
        await bot.reply("🗑️ Memória da Luma limpa nesta conversa!");
        return true;

      case COMMANDS.MY_NUMBER: {
        const num  = await bot.getSenderNumber();
        const chat = bot.jid;
        await bot.reply(`📱 *Informações de ID*\n\n👤 *Seu Número:* ${num}\n💬 *ID deste Chat:* ${chat}`);
        return true;
      }

      case COMMANDS.STICKER:
      case COMMANDS.STICKER_SHORT:
        await CommandRouter._handleSticker(bot);
        return true;

      case COMMANDS.IMAGE:
      case COMMANDS.IMAGE_SHORT:
        await CommandRouter._handleImage(bot);
        return true;

      case COMMANDS.GIF:
      case COMMANDS.GIF_SHORT:
        await CommandRouter._handleGif(bot);
        return true;

      case COMMANDS.DOWNLOAD: {
        const url = extractUrl(bot.body) || extractUrl(bot.quotedText);
        if (url) {
          await CommandRouter._handleVideoDownload(bot, url);
        } else {
          await bot.reply(MESSAGES.VIDEO_NO_URL);
        }
        return true;
      }

      case COMMANDS.EVERYONE:
        await bot.react("📢");
        if (bot.isGroup) {
          await GroupManager.mentionEveryone(bot.raw, bot.socket);
        } else {
          await bot.reply("⚠️ Este comando só funciona em grupos!");
        }
        return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Handlers privados
  // ---------------------------------------------------------------------------

  /** @private */
  static async _handleSticker(bot) {
    await bot.react("⏳");
    const url = extractUrl(bot.body);
    if (url) {
      await MediaProcessor.processUrlToSticker(url, bot.socket, bot.raw);
      CommandRouter._incrementMedia("stickers_created");
      await bot.react("✅");
      return;
    }
    if (bot.hasMedia) {
      await MediaProcessor.processToSticker(bot.raw, bot.socket);
      CommandRouter._incrementMedia("stickers_created");
      await bot.react("✅");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasVisualContent) {
      await MediaProcessor.processToSticker(quoted.raw, bot.socket, bot.jid);
      CommandRouter._incrementMedia("stickers_created");
      await bot.react("✅");
    } else {
      await bot.react("❌");
      await bot.reply(MESSAGES.REPLY_MEDIA_STICKER);
    }
  }

  /** @private */
  static async _handleImage(bot) {
    await bot.react("⏳");
    if (bot.hasSticker) {
      await MediaProcessor.processStickerToImage(bot.raw, bot.socket);
      CommandRouter._incrementMedia("images_created");
      await bot.react("✅");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasSticker) {
      await MediaProcessor.processStickerToImage(quoted.raw, bot.socket, bot.jid);
      CommandRouter._incrementMedia("images_created");
      await bot.react("✅");
    } else {
      await bot.react("❌");
      await bot.reply(MESSAGES.REPLY_STICKER_IMAGE);
    }
  }

  /** @private */
  static async _handleGif(bot) {
    await bot.react("⏳");
    if (bot.hasSticker) {
      await MediaProcessor.processStickerToGif(bot.raw, bot.socket);
      CommandRouter._incrementMedia("gifs_created");
      await bot.react("✅");
      return;
    }
    const quoted = bot.getQuotedAdapter();
    if (quoted?.hasSticker) {
      await MediaProcessor.processStickerToGif(quoted.raw, bot.socket, bot.jid);
      CommandRouter._incrementMedia("gifs_created");
      await bot.react("✅");
    } else {
      await bot.react("❌");
      await bot.reply(MESSAGES.REPLY_STICKER_GIF);
    }
  }

  /** @private */
  static async _handleVideoDownload(bot, url) {
    let filePath = null;
    let convertedPath = null;
    try {
      await bot.react("⏳");
      Logger.info(`🎬 Iniciando download de vídeo social: ${url}`);

      filePath = await VideoDownloader.download(url);
      Logger.info("🔄 Remuxando para compatibilidade com iOS...");
      convertedPath = await VideoConverter.remuxForMobile(filePath);

      const videoBuffer = fs.readFileSync(convertedPath);
      await bot.socket.sendMessage(bot.jid, { video: videoBuffer, caption: MESSAGES.VIDEO_SENT });

      Logger.info("✅ Vídeo social enviado com sucesso.");
      DatabaseService.incrementMetric("videos_downloaded");
      DatabaseService.incrementMetric("total_messages");
      await bot.react("✅");
    } catch (error) {
      Logger.error("❌ Erro no download de vídeo social:", error.message);
      if (error.message?.includes("yt-dlp") && error.message?.includes("not found")) {
        await bot.reply(MESSAGES.YTDLP_NOT_FOUND);
      } else if (error.message?.includes("File is larger")) {
        await bot.reply(MESSAGES.VIDEO_TOO_LARGE);
      } else {
        await bot.reply(MESSAGES.VIDEO_DOWNLOAD_ERROR);
      }
      await bot.react("❌");
    } finally {
      for (const f of [filePath, convertedPath]) {
        if (f) try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  }

  /** @private */
  static async _sendStats(bot, lumaHandler) {
    const dbStats    = DatabaseService.getMetrics();
    const memStats   = lumaHandler?.getStats() ?? { totalConversations: 0 };

    const text =
      `📊 *Estatísticas Globais da Luma*\n\n` +
      `🧠 *Inteligência Artificial:*\n` +
      `• Respostas Geradas: ${dbStats.ai_responses || 0}\n` +
      `• Conversas Ativas (RAM): ${memStats.totalConversations}\n\n` +
      `🎨 *Mídia Gerada:*\n` +
      `• Figurinhas: ${dbStats.stickers_created || 0}\n` +
      `• Imagens: ${dbStats.images_created || 0}\n` +
      `• GIFs: ${dbStats.gifs_created || 0}\n` +
      `• Vídeos Baixados: ${dbStats.videos_downloaded || 0}\n\n` +
      `📈 *Total de Interações:* ${dbStats.total_messages || 0}`;

    await bot.sendText(text);
  }

  /** @private */
  static async _sendPersonalityMenu(bot) {
    const list        = PersonalityManager.getList();
    const currentName = PersonalityManager.getActiveName(bot.jid);

    let text = `${MENUS.PERSONALITY.HEADER}\n`;
    text += `🔹 Atual neste chat: ${currentName}\n\n`;

    list.forEach((p, i) => {
      const isDefault = p.key === LUMA_CONFIG.DEFAULT_PERSONALITY ? " ⭐ (Padrão)" : "";
      text += `p${i + 1} - ${p.name}${isDefault}\n${p.desc}\n\n`;
    });

    text += MENUS.PERSONALITY.FOOTER;
    await bot.sendText(text);
  }

  /** @private */
  static _incrementMedia(type) {
    DatabaseService.incrementMetric(type);
    DatabaseService.incrementMetric("total_messages");
  }
}
