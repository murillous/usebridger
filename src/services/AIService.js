import { GoogleGenAI } from "@google/genai";
import { Logger } from "../utils/Logger.js";
import { LUMA_CONFIG } from "../config/lumaConfig.js";
import { WebSearchService } from "./WebSearchService.js";

/**
 * Serviço de comunicação com a API do Google Gemini.
 * Tenta múltiplos modelos em sequência (fallback automático).
 */
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

  /** Envia conteúdo para o Gemini com fallback entre modelos configurados. */
  async generateContent(contents) {
    let lastError = null;

    for (const model of this.models) {
      const modelStats = this.stats.get(model);

      try {
        Logger.info(`🤖 AIService: Tentando modelo ${model}...`);

        const response = await this._callModel(model, contents);
        const result = this._extractFromResponse(response);

        if (result.functionCalls.length > 0) {
          Logger.info(`🔧 AIService: função(ões) chamada(s): ${result.functionCalls.map(fc => fc.name).join(', ')}`);
        }

        // Multi-turn: se o modelo quer buscar na internet, executa e reenvia
        const searchCall = result.functionCalls.find((fc) => fc.name === "search_web");
        if (searchCall) {
          const finalResult = await this._handleSearchTurn(model, contents, response, result, searchCall);
          modelStats.successes++;
          modelStats.lastUsed = new Date().toISOString();
          modelStats.lastError = null;
          return finalResult;
        }

        modelStats.successes++;
        modelStats.lastUsed = new Date().toISOString();
        modelStats.lastError = null;

        return result;
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

  /** @private */
  async _callModel(model, contents) {
    return await this.client.models.generateContent({
      model,
      contents,
      config: {
        tools: LUMA_CONFIG.TOOLS,
        temperature: this.genConfig.temperature,
        maxOutputTokens: this.genConfig.maxOutputTokens,
        topP: this.genConfig.topP,
        topK: this.genConfig.topK,
        safetySettings: [
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      },
    });
  }

  /**
   * Executa o loop multi-turn de busca:
   * 1. Chama WebSearchService com a query
   * 2. Reenvia os resultados ao modelo como functionResponse
   * 3. Recebe a resposta final com o texto gerado a partir da busca
   * @private
   */
  async _handleSearchTurn(model, originalContents, modelResponse, firstResult, searchCall) {
    try {
      const query = searchCall.args?.query || "";
      Logger.info(`🔍 Luma buscando: "${query}"`);

      const searchResults = await WebSearchService.search(query, this.client, model);

      const modelContent = modelResponse.candidates?.[0]?.content;
      const followUpContents = [
        ...originalContents,
        modelContent,
        {
          role: "user",
          parts: [{
            functionResponse: {
              name: "search_web",
              response: { result: searchResults },
            },
          }],
        },
      ];

      const followUpResponse = await this._callModel(model, followUpContents);
      const finalResult = this._extractFromResponse(followUpResponse);

      // Preserva tool calls não relacionadas à busca da primeira resposta
      const otherCalls = firstResult.functionCalls.filter((fc) => fc.name !== "search_web");
      finalResult.functionCalls = [...otherCalls, ...finalResult.functionCalls];

      return finalResult;
    } catch (error) {
      Logger.error(`❌ Erro no turno de busca: ${error.message}`);
      return {
        text: firstResult.text,
        functionCalls: firstResult.functionCalls.filter((fc) => fc.name !== "search_web"),
      };
    }
  }

  /**
   * Extrai texto e chamadas de ferramenta da resposta da IA.
   * Trata tanto a estrutura candidates/parts quanto acessores diretos.
   */
  _extractFromResponse(response) {
    let text = "";
    let functionCalls = [];

    const parts = response.candidates?.[0]?.content?.parts;

    if (parts) {
      for (const part of parts) {
        if (part.text) text += part.text;
        if (part.functionCall) functionCalls.push(part.functionCall);
      }
    } else {
      try {
        if (response.text) text = response.text;
      } catch (e) { }

      try {
        if (response.functionCalls && Array.isArray(response.functionCalls)) {
          functionCalls = response.functionCalls;
        }
      } catch (e) { }
    }

    return { text, functionCalls };
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
      successes: data.successes,
      failures: data.failures,
      lastError: data.lastError,
    }));
  }
}
