import { describe, it, expect, vi } from 'vitest';

// Mocka LUMA_CONFIG com templates simples e previsíveis.
vi.mock('../../../../src/config/lumaConfig.js', () => ({
  LUMA_CONFIG: {
    PROMPT_TEMPLATE: [
      'CONTEXTO:{{PERSONALITY_CONTEXT}}',
      'ESTILO:{{PERSONALITY_STYLE}}',
      'TRAITS:{{PERSONALITY_TRAITS}}',
      '{{HISTORY_PLACEHOLDER}}',
      '{{GROUP_CONTEXT_PLACEHOLDER}}',
      '[USUÁRIO ATUAL]{{USER_MESSAGE}}',
    ].join('\n'),

    VISION_PROMPT_TEMPLATE: [
      '[VISÃO]CONTEXTO:{{PERSONALITY_CONTEXT}}',
      '{{HISTORY_PLACEHOLDER}}',
      '[USUÁRIO ATUAL]{{USER_MESSAGE}}',
    ].join('\n'),
  },
}));

import { buildPromptRequest } from '../../../../src/core/services/PromptBuilder.js';

const DEFAULT_PERSONA = {
  context: 'Você é a Luma.',
  style:   'informal',
  traits:  ['seja amigável', 'seja direta'],
};

const NO_HISTORY = 'Nenhuma conversa anterior.';

// ── estrutura de retorno ───────────────────────────────────────────────────────

describe('buildPromptRequest — estrutura de retorno', () => {
  it('retorna array com um elemento de role "user"', () => {
    const result = buildPromptRequest({
      userMessage:  'oi',
      historyText:  NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:   'Teste',
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('partes contém pelo menos um objeto com campo "text"', () => {
    const result = buildPromptRequest({
      userMessage:  'olá',
      historyText:  NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:   'U',
    });

    const { parts } = result[0];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(typeof parts[0].text).toBe('string');
  });
});

// ── conteúdo do prompt ─────────────────────────────────────────────────────────

describe('buildPromptRequest — conteúdo do prompt', () => {
  it('inclui a mensagem do usuário no texto', () => {
    const result = buildPromptRequest({
      userMessage:   'qual é a capital?',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'Maria',
    });

    const text = result[0].parts[0].text;
    expect(text).toContain('qual é a capital?');
  });

  it('inclui o senderName no texto', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'João',
    });

    expect(result[0].parts[0].text).toContain('João');
  });

  it('inclui o contexto da persona', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
    });

    expect(result[0].parts[0].text).toContain('Você é a Luma.');
  });

  it('inclui os traits da persona como lista', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
    });

    const text = result[0].parts[0].text;
    expect(text).toContain('- seja amigável');
    expect(text).toContain('- seja direta');
  });

  it('inclui histórico quando presente', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   'User: oi\nLuma: olá',
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
    });

    expect(result[0].parts[0].text).toContain('CONVERSA ANTERIOR:');
    expect(result[0].parts[0].text).toContain('User: oi');
  });

  it('NÃO inclui bloco de histórico para "Nenhuma conversa anterior."', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
    });

    expect(result[0].parts[0].text).not.toContain('CONVERSA ANTERIOR:');
  });

  it('inclui groupContext quando fornecido', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
      groupContext:  'discussão sobre futebol',
    });

    expect(result[0].parts[0].text).toContain('discussão sobre futebol');
  });

  it('NÃO inclui groupContext quando vazio', () => {
    const result = buildPromptRequest({
      userMessage:   'msg',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
      groupContext:  '',
    });

    expect(result[0].parts[0].text).not.toContain('CONVERSA RECENTE NO GRUPO');
  });
});

// ── imageData / visão ──────────────────────────────────────────────────────────

describe('buildPromptRequest — modo visão (imageData)', () => {
  const imageData = { inlineData: { data: 'base64==', mimeType: 'image/jpeg' } };

  it('adiciona imageData como segunda parte quando presente', () => {
    const result = buildPromptRequest({
      userMessage:   'o que é isso?',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
      imageData,
    });

    const { parts } = result[0];
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual(imageData);
  });

  it('usa VISION_PROMPT_TEMPLATE quando imageData presente', () => {
    const result = buildPromptRequest({
      userMessage:   'analise',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
      imageData,
    });

    // O template de visão começa com "[VISÃO]"
    expect(result[0].parts[0].text).toContain('[VISÃO]');
  });

  it('usa PROMPT_TEMPLATE normal quando sem imageData', () => {
    const result = buildPromptRequest({
      userMessage:   'texto',
      historyText:   NO_HISTORY,
      personaConfig: DEFAULT_PERSONA,
      senderName:    'U',
    });

    expect(result[0].parts[0].text).not.toContain('[VISÃO]');
    expect(result[0].parts).toHaveLength(1);
  });
});
