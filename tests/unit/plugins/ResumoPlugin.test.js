import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ResumoPlugin } = await import('../../../src/plugins/resumo/ResumoPlugin.js');
const { COMMANDS }     = await import('../../../src/config/constants.js');

function makeLumaHandler({ historyText = 'Usuário: oi\nLuma: olá', responseText = 'Rolou um papo legal.' } = {}) {
  return {
    isConfigured: true,
    history: { getText: vi.fn().mockReturnValue(historyText) },
    aiService: {
      generateContent: vi.fn().mockResolvedValue({ text: responseText, functionCalls: [] }),
    },
  };
}

function makeBot(body = '!resumo') {
  return {
    jid: 'grupo@g.us',
    body,
    reply:        vi.fn().mockResolvedValue({}),
    sendPresence: vi.fn().mockResolvedValue({}),
  };
}

describe('ResumoPlugin', () => {
  describe('commands', () => {
    it('declara o comando !resumo', () => {
      expect(ResumoPlugin.commands).toContain(COMMANDS.RESUMO);
    });
  });

  describe('onCommand — histórico presente', () => {
    it('chama a IA e responde com o resumo', async () => {
      const lumaHandler = makeLumaHandler();
      const bot = makeBot();
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      expect(lumaHandler.aiService.generateContent).toHaveBeenCalledOnce();
      expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('Rolou um papo legal.'));
    });

    it('usa o limite padrão de 40 linhas quando não informado', async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `Linha ${i}`).join('\n');
      const lumaHandler = makeLumaHandler({ historyText: lines });
      const bot = makeBot('!resumo');
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      const [[promptParts]] = lumaHandler.aiService.generateContent.mock.calls;
      const promptText = promptParts[0].parts[0].text;
      const linesInPrompt = promptText.split('\n').filter(l => l.startsWith('Linha')).length;
      expect(linesInPrompt).toBe(40);
    });

    it('respeita o limite numérico informado — !resumo 10', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `Linha ${i}`).join('\n');
      const lumaHandler = makeLumaHandler({ historyText: lines });
      const bot = makeBot('!resumo 10');
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      const [[promptParts]] = lumaHandler.aiService.generateContent.mock.calls;
      const promptText = promptParts[0].parts[0].text;
      const linesInPrompt = promptText.split('\n').filter(l => l.startsWith('Linha')).length;
      expect(linesInPrompt).toBe(10);
    });

    it('aplica o teto máximo de 100 linhas', async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Linha ${i}`).join('\n');
      const lumaHandler = makeLumaHandler({ historyText: lines });
      const bot = makeBot('!resumo 999');
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      const [[promptParts]] = lumaHandler.aiService.generateContent.mock.calls;
      const promptText = promptParts[0].parts[0].text;
      const linesInPrompt = promptText.split('\n').filter(l => l.startsWith('Linha')).length;
      expect(linesInPrompt).toBe(100);
    });
  });

  describe('onCommand — sem histórico', () => {
    it('avisa que não há conversa salva', async () => {
      const lumaHandler = makeLumaHandler({ historyText: 'Nenhuma conversa anterior.' });
      const bot = makeBot();
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      expect(lumaHandler.aiService.generateContent).not.toHaveBeenCalled();
      expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('Não tem conversa'));
    });
  });

  describe('onCommand — IA não configurada', () => {
    it('responde com erro de configuração', async () => {
      const lumaHandler = { isConfigured: false };
      const bot = makeBot();
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('não configurada'));
    });
  });

  describe('onCommand — erro na IA', () => {
    it('responde com mensagem de erro', async () => {
      const lumaHandler = makeLumaHandler();
      lumaHandler.aiService.generateContent.mockRejectedValue(new Error('timeout'));
      const bot = makeBot();
      const plugin = new ResumoPlugin({ lumaHandler });

      await plugin.onCommand(COMMANDS.RESUMO, bot);

      expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('Não consegui'));
    });
  });
});
