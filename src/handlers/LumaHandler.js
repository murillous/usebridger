import { AIService } from "../services/AIService.js";
import { Logger } from "../utils/Logger.js";
import { LUMA_CONFIG } from "../config/lumaConfig.js";
import { MediaProcessor } from "./MediaProcessor.js";
import { PersonalityManager } from "../managers/PersonalityManager.js";
import { DatabaseService } from "../services/Database.js";
import dotenv from "dotenv";

dotenv.config();

export class LumaHandler {
  constructor() {
    this.conversationHistory = new Map();
    this.lastBotMessages = new Map();
    this.aiService = null;

    this._initializeService(process.env.GEMINI_API_KEY);
    this._startCleanupInterval();
  }

  _initializeService(apiKey) {
    if (!apiKey || apiKey === "Sua Chave Aqui") {
      Logger.error("❌ Luma não configurada: GEMINI_API_KEY ausente no .env");
      return;
    }
    try {
      this.aiService = new AIService(apiKey);
      Logger.info("✅ Luma Service inicializado e pronto.");
    } catch (error) {
      Logger.error("❌ Falha crítica ao iniciar AIService:", error.message);
      this.aiService = null;
    }
  }

  get isConfigured() {
    return this.aiService !== null;
  }

  async generateResponse(
    userMessage,
    userJid,
    message = null,
    sock = null,
    senderName = "Usuário",
  ) {
    if (!this.isConfigured) return this._getErrorResponse("API_KEY_MISSING");

    try {
      const personaConfig = PersonalityManager.getPersonaConfig(userJid);
      const imageData =
        message && sock ? await this._extractImage(message, sock) : null;

      const promptParts = this._buildPromptRequest(
        userMessage,
        userJid,
        imageData,
        personaConfig,
        senderName,
      );

      const rawText = await this.aiService.generateContent(promptParts);

      const cleanedResponse = this._cleanResponseText(rawText);

      this._addToHistory(userJid, userMessage, cleanedResponse, senderName);

      this._updateMetrics(userJid);

      return cleanedResponse;
    } catch (error) {
      Logger.error("❌ Erro no fluxo Luma:", error.message);
      return this._getErrorResponse("GENERAL", error);
    }
  }

  _buildPromptRequest(
    userMessage,
    userJid,
    imageData,
    personaConfig,
    senderName,
  ) {
    const history = this._getHistoryText(userJid);
    const hasHistory = history !== "Nenhuma conversa anterior.";

    const template = imageData
      ? LUMA_CONFIG.VISION_PROMPT_TEMPLATE
      : LUMA_CONFIG.PROMPT_TEMPLATE;

    const traitsStr = personaConfig.traits.map((t) => `- ${t}`).join("\n");

    const promptText = template
      .replace("{{PERSONALITY_CONTEXT}}", personaConfig.context)
      .replace("{{PERSONALITY_STYLE}}", personaConfig.style)
      .replace("{{PERSONALITY_TRAITS}}", traitsStr)
      .replace(
        "{{HISTORY_PLACEHOLDER}}",
        hasHistory ? `CONVERSA ANTERIOR:\n${history}\n` : "",
      )
      // ✅ Injeta o nome na mensagem atual
      .replace("{{USER_MESSAGE}}", `${senderName}: ${userMessage}`);

    const parts = [{ text: promptText }];
    if (imageData) {
      parts.push(imageData);
    }

    return [{ role: "user", parts }];
  }

  async _extractImage(message, sock) {
    try {
      if (message.message?.imageMessage || message.message?.stickerMessage) {
        return await this._convertImageToBase64(message, sock);
      }
      const quoted =
        message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quoted?.imageMessage || quoted?.stickerMessage) {
        const msgType = quoted.imageMessage ? "imageMessage" : "stickerMessage";
        const fakeMsg = {
          message: { [msgType]: quoted[msgType] },
          key: message.key,
        };
        return await this._convertImageToBase64(fakeMsg, sock);
      }
      return null;
    } catch (error) {
      Logger.error("❌ Erro ao extrair imagem:", error);
      return null;
    }
  }

  async _convertImageToBase64(message, sock) {
    const buffer = await MediaProcessor.downloadMedia(message, sock);
    if (!buffer) return null;
    const base64Image = buffer.toString("base64");
    const mimeType = message.message?.stickerMessage
      ? "image/webp"
      : "image/jpeg";
    return { inlineData: { data: base64Image, mimeType } };
  }

  _cleanResponseText(text) {
    if (!text) return "";
    let cleaned = text
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^Luma:\s*/i, "")
      .trim();

    if (cleaned.length > LUMA_CONFIG.TECHNICAL.maxResponseLength) {
      cleaned =
        cleaned.substring(0, LUMA_CONFIG.TECHNICAL.maxResponseLength - 3) +
        "...";
    }
    return cleaned;
  }

  _addToHistory(userJid, userMessage, botResponse, senderName) {
    if (!this.conversationHistory.has(userJid)) {
      this.conversationHistory.set(userJid, {
        messages: [],
        lastUpdate: Date.now(),
      });
    }

    const data = this.conversationHistory.get(userJid);
    // Formato: "Nome: Mensagem"
    data.messages.push(`${senderName}: ${userMessage}`);
    data.messages.push(`Luma: ${botResponse}`);
    data.lastUpdate = Date.now();

    if (data.messages.length > LUMA_CONFIG.TECHNICAL.maxHistory) {
      data.messages.splice(
        0,
        data.messages.length - LUMA_CONFIG.TECHNICAL.maxHistory,
      );
    }
  }

  _getHistoryText(userJid) {
    const data = this.conversationHistory.get(userJid);
    return data?.messages.join("\n") || "Nenhuma conversa anterior.";
  }

  _startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      for (const [jid, data] of this.conversationHistory.entries()) {
        if (now - data.lastUpdate > LUMA_CONFIG.TECHNICAL.maxHistoryAge) {
          this.conversationHistory.delete(jid);
        }
      }
    }, LUMA_CONFIG.TECHNICAL.historyCleanupInterval);
  }

  _updateMetrics(userJid) {
    Logger.info(`💬 Luma respondeu para ${userJid.split("@")[0]}`);
    DatabaseService.incrementMetric("ai_responses");
    DatabaseService.incrementMetric("total_messages");
  }

  static isTriggered(text) {
    if (!text) return false;
    return LUMA_CONFIG.TRIGGERS.some((regex) =>
      regex.test(text.toLowerCase().trim()),
    );
  }

  isReplyToLuma(message) {
    if (!this.isConfigured) return false;
    const quotedMsg = message.message?.extendedTextMessage?.contextInfo;
    if (!quotedMsg?.quotedMessage) return false;
    const quotedMsgId = quotedMsg.stanzaId;
    const jid = message.key.remoteJid;
    return quotedMsgId === this.lastBotMessages.get(jid);
  }

  saveLastBotMessage(jid, messageId) {
    if (messageId) this.lastBotMessages.set(jid, messageId);
  }

  extractUserMessage(text) {
    return text
      .replace(/^(ei\s+|oi\s+|e\s+aí\s+|fala\s+)?luma[,!?]?\s*/i, "")
      .trim();
  }

  clearHistory(userJid) {
    this.conversationHistory.delete(userJid);
    Logger.info(`🗑️ Histórico limpo para ${userJid}`);
  }

  getStats() {
    const historySize = this.conversationHistory
      ? this.conversationHistory.size
      : 0;
    const modelStats = this.aiService ? this.aiService.getStats() : [];
    return {
      totalConversations: historySize,
      modelStats: modelStats,
    };
  }

  getRandomBoredResponse() {
    const responses = LUMA_CONFIG.BORED_RESPONSES;
    return responses[Math.floor(Math.random() * responses.length)];
  }

  _getErrorResponse(type, error = null) {
    const errorConfig = LUMA_CONFIG.ERROR_RESPONSES;
    switch (type) {
      case "API_KEY_MISSING":
        return errorConfig.API_KEY_MISSING;
      case "QUOTA_EXCEEDED":
        return errorConfig.QUOTA_EXCEEDED;
      default:
        const general = errorConfig.GENERAL;
        return general[Math.floor(Math.random() * general.length)];
    }
  }
}
