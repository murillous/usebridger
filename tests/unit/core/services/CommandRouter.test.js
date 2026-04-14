import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks de todos os módulos que CommandRouter importa
vi.mock('../../../../src/handlers/MediaProcessor.js', () => ({
  MediaProcessor: { processToSticker: vi.fn(), processStickerToImage: vi.fn(), processStickerToGif: vi.fn(), processUrlToSticker: vi.fn(), downloadMedia: vi.fn() },
}));

vi.mock('../../../../src/managers/GroupManager.js', () => ({
  GroupManager: { mentionEveryone: vi.fn() },
}));

vi.mock('../../../../src/services/VideoDownloader.js', () => ({
  VideoDownloader: { download: vi.fn(), detectVideoUrl: vi.fn() },
}));

vi.mock('../../../../src/processors/VideoConverter.js', () => ({
  VideoConverter: { remuxForMobile: vi.fn(), toSticker: vi.fn(), toGif: vi.fn(), toMp4: vi.fn() },
}));

vi.mock('../../../../src/services/Database.js', () => ({
  DatabaseService: { incrementMetric: vi.fn(), getMetrics: vi.fn().mockReturnValue({}) },
}));

vi.mock('../../../../src/managers/PersonalityManager.js', () => ({
  PersonalityManager: {
    getList: vi.fn().mockReturnValue([{ key: 'default', name: 'Luma', desc: 'Assistente' }]),
    getActiveName: vi.fn().mockReturnValue('Luma'),
    setPersonality: vi.fn(),
  },
}));

vi.mock('../../../../src/config/lumaConfig.js', () => ({
  LUMA_CONFIG: { DEFAULT_PERSONALITY: 'default' },
}));

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn().mockReturnValue(Buffer.from('')), unlinkSync: vi.fn() },
}));

const { CommandRouter } = await import('../../../../src/core/services/CommandRouter.js');

// Helper para criar bot mock
function makeBot(overrides = {}) {
  return {
    jid: '123@s.whatsapp.net',
    body: '',
    quotedText: null,
    isGroup: false,
    isFromMe: false,
    hasMedia: false,
    hasSticker: false,
    hasVisualContent: false,
    raw: { key: { remoteJid: '123@s.whatsapp.net' } },
    socket: { sendMessage: vi.fn(), groupMetadata: vi.fn() },
    reply: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    sendText: vi.fn().mockResolvedValue({}),
    react: vi.fn().mockResolvedValue({}),
    getQuotedAdapter: vi.fn().mockReturnValue(null),
    getSenderNumber: vi.fn().mockResolvedValue('5511999999999'),
    ...overrides,
  };
}

describe('CommandRouter.detect — comandos', () => {
  it.each([
    ['!sticker',      '!sticker'],
    ['!s',            '!sticker'],
    ['!image',        '!image'],
    ['!i',            '!image'],
    ['!gif',          '!gif'],
    ['!g',            '!gif'],
    ['!help',         '!help'],
    ['!menu',         '!help'],
    ['!persona',      '!persona'],
    ['!download url', '!download'],
    ['!d url',        '!download'],
    ['!luma clear',   '!luma clear'],
    ['!lc',           '!luma clear'],
    ['!clear',        '!clear'],
    ['!luma stats',   '!luma stats'],
    ['!ls',           '!luma stats'],
    ['!meunumero',    '!meunumero'],
    ['@everyone',     '@everyone'],
    ['@todos',        '@everyone'],
  ])('detecta "%s" como "%s"', (input, expected) => {
    expect(CommandRouter.detect(input)).toBe(expected);
  });

  it('retorna null para texto sem comando', () => {
    expect(CommandRouter.detect('oi luma tudo bem?')).toBeNull();
  });

  it('retorna null para null', () => {
    expect(CommandRouter.detect(null)).toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(CommandRouter.detect('')).toBeNull();
  });

  it('é case-insensitive', () => {
    expect(CommandRouter.detect('!STICKER')).toBe('!sticker');
    expect(CommandRouter.detect('!Help')).toBe('!help');
  });
});

describe('CommandRouter.dispatch — !help', () => {
  it('envia o texto do menu de ajuda', async () => {
    const bot = makeBot({ body: '!help' });
    const handled = await CommandRouter.dispatch(bot, '!help');
    expect(handled).toBe(true);
    expect(bot.sendText).toHaveBeenCalled();
  });
});

describe('CommandRouter.dispatch — !luma clear', () => {
  it('chama clearHistory no lumaHandler e responde', async () => {
    const bot = makeBot({ body: '!lc' });
    const lumaHandler = { clearHistory: vi.fn() };

    const handled = await CommandRouter.dispatch(bot, '!luma clear', { lumaHandler });
    expect(handled).toBe(true);
    expect(lumaHandler.clearHistory).toHaveBeenCalledWith(bot.jid);
    expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('limpa'));
  });

  it('não lança erro se lumaHandler não for passado', async () => {
    const bot = makeBot();
    await expect(CommandRouter.dispatch(bot, '!luma clear')).resolves.toBe(true);
  });
});

describe('CommandRouter.dispatch — !meunumero', () => {
  it('responde com o número e ID do chat', async () => {
    const bot = makeBot();
    const handled = await CommandRouter.dispatch(bot, '!meunumero');
    expect(handled).toBe(true);
    expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('Seu Número'));
  });
});

describe('CommandRouter.dispatch — !persona', () => {
  it('envia o menu de personalidades', async () => {
    const bot = makeBot();
    const handled = await CommandRouter.dispatch(bot, '!persona');
    expect(handled).toBe(true);
    expect(bot.sendText).toHaveBeenCalled();
  });
});

describe('CommandRouter.dispatch — !luma stats', () => {
  it('envia estatísticas', async () => {
    const bot = makeBot();
    const lumaHandler = { getStats: vi.fn().mockReturnValue({ totalConversations: 5 }) };
    const handled = await CommandRouter.dispatch(bot, '!luma stats', { lumaHandler });
    expect(handled).toBe(true);
    expect(bot.sendText).toHaveBeenCalledWith(expect.stringContaining('Estatísticas'));
  });
});

describe('CommandRouter.dispatch — !download', () => {
  it('responde com mensagem de sem URL quando não encontra URL', async () => {
    const bot = makeBot({ body: '!download', quotedText: null });
    const handled = await CommandRouter.dispatch(bot, '!download');
    expect(handled).toBe(true);
    expect(bot.reply).toHaveBeenCalled();
  });
});

describe('CommandRouter.dispatch — @everyone', () => {
  it('reage com 📢 e avisa que só funciona em grupos quando em PV', async () => {
    const bot = makeBot({ isGroup: false });
    await CommandRouter.dispatch(bot, '@everyone');
    expect(bot.react).toHaveBeenCalledWith('📢');
    expect(bot.reply).toHaveBeenCalledWith(expect.stringContaining('grupos'));
  });

  it('chama GroupManager.mentionEveryone quando em grupo', async () => {
    const { GroupManager } = await import('../../../../src/managers/GroupManager.js');
    const bot = makeBot({ isGroup: true });
    await CommandRouter.dispatch(bot, '@everyone');
    expect(GroupManager.mentionEveryone).toHaveBeenCalled();
  });
});

describe('CommandRouter.dispatch — comando desconhecido', () => {
  it('retorna false para comando não registrado', async () => {
    const bot = makeBot();
    const handled = await CommandRouter.dispatch(bot, '!naoexiste');
    expect(handled).toBe(false);
  });
});
