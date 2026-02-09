import { GoogleGenAI } from "@google/genai";
import { Logger } from "../utils/Logger.js";
import { LUMA_CONFIG } from "../config/lumaConfig.js";

export class AIService {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error("AIService: API Key não fornecida na inicialização.");
    }

    this.client = new GoogleGenAI({ apiKey });
    this.models = LUMA_CONFIG.TECHNICAL.models;
    this.genConfig = LUMA_CONFIG.TECHNICAL.generationConfig;
    this.stats = this._initializeStats();
  }

  _initializeStats() {
    const stats = new Map();
    this.models.forEach((model) => {
      stats.set(model, {
        successes: 0,
        failures: 0,
        lastUsed: null,
        lastError: null,
      });
    });
    return stats;
  }

  async generateContent(contents) {
    let lastError = null;

    for (const model of this.models) {
      const modelStats = this.stats.get(model);

      try {
        Logger.info(`🤖 AIService: Tentando modelo ${model}...`);

        const response = await this.client.models.generateContent({
          model: model,
          contents: contents,
          generationConfig: {
            temperature: this.genConfig.temperature,
            maxOutputTokens: this.genConfig.maxOutputTokens,
            topP: this.genConfig.topP,
            topK: this.genConfig.topK,
          },
        });

        const text = this._extractTextFromResponse(response);

        modelStats.successes++;
        modelStats.lastUsed = new Date().toISOString();
        modelStats.lastError = null;

        return text;
      } catch (error) {
        modelStats.failures++;
        modelStats.lastError = error.message;
        lastError = error;

        this._logError(model, error);
        continue;
      }
    }

    throw new Error(
      `Todos os modelos falharam. Último erro: ${lastError?.message}`,
    );
  }

  _extractTextFromResponse(response) {
    if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
      return response.candidates[0].content.parts[0].text;
    }
    if (typeof response.text === "string") {
      return response.text;
    }
    throw new Error("Formato de resposta da IA desconhecido");
  }

  _logError(model, error) {
    if (
      error.message?.includes("404") ||
      error.message?.includes("not found")
    ) {
      Logger.warn(`❌ Modelo ${model} indisponível.`);
    } else if (error.message?.includes("429") || error.status === 429) {
      Logger.warn(`⚠️ Rate limit no ${model}, trocando...`);
    } else {
      Logger.error(`❌ Erro no ${model}: ${error.message}`);
    }
  }

  getStats() {
    return Array.from(this.stats.entries()).map(([model, data]) => ({
      model,
      ...data,
    }));
  }
}
