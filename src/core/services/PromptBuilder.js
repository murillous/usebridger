import { LUMA_CONFIG } from '../../config/lumaConfig.js';

/**
 * Monta o array `contents` no formato Gemini-style a partir dos dados da conversa.
 *
 * @param {object} params
 * @param {string}      params.userMessage
 * @param {string}      params.historyText    - Texto formatado do histórico (de ConversationHistory.getText)
 * @param {object}      params.personaConfig  - Retorno de PersonalityManager.getPersonaConfig()
 * @param {string}      params.senderName
 * @param {string}      [params.groupContext]
 * @param {object|null} [params.imageData]    - Dado de imagem em base64 para visão, se disponível
 * @returns {Array<{role: string, parts: Array}>}
 */
export function buildPromptRequest({
  userMessage,
  historyText,
  personaConfig,
  senderName,
  groupContext = '',
  imageData    = null,
}) {
  const template = imageData
    ? LUMA_CONFIG.VISION_PROMPT_TEMPLATE
    : LUMA_CONFIG.PROMPT_TEMPLATE;

  const traitsStr = personaConfig.traits.map(t => `- ${t}`).join('\n');

  const groupContextStr = groupContext
    ? `[CONVERSA RECENTE NO GRUPO]\n(o que estava sendo discutido antes de você ser chamada)\n${groupContext}\n\n`
    : '';

  const hasHistory = historyText !== 'Nenhuma conversa anterior.';

  const promptText = template
    .replace('{{PERSONALITY_CONTEXT}}', personaConfig.context)
    .replace('{{PERSONALITY_STYLE}}',   personaConfig.style)
    .replace('{{PERSONALITY_TRAITS}}',  traitsStr)
    .replace('{{HISTORY_PLACEHOLDER}}', hasHistory ? `CONVERSA ANTERIOR:\n${historyText}\n` : '')
    .replace('{{GROUP_CONTEXT_PLACEHOLDER}}', groupContextStr)
    .replace('{{USER_MESSAGE}}', `${senderName}: ${userMessage}`);

  const parts = [{ text: promptText }];
  if (imageData) parts.push(imageData);

  return [{ role: 'user', parts }];
}
