import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/handlers/MessageHandler.js', () => ({
  MessageHandler: { process: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../../src/adapters/BaileysAdapter.js', () => ({
  BaileysAdapter: class {
    constructor(sock, msg) {
      this.sock    = sock;
      this.message = msg;
      this.jid     = msg?.key?.remoteJid ?? 'unknown@s.whatsapp.net';
    }
  },
}));

// JidQueue como passthrough: não altera o comportamento observável do roteador
vi.mock('../../../src/infra/JidQueue.js', () => ({
  JidQueue: class {
    enqueue(_jid, fn) { return fn(); }
    get activeQueues() { return 0; }
  },
}));

import { routeMessages } from '../../../src/infra/MessageRouter.js';
import { MessageHandler } from '../../../src/handlers/MessageHandler.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const mockSock = {};

function makeUpsert(messages, type = 'notify') {
  return { type, messages };
}

function makeMessage(withMessageField = true, jid = 'jid@s.whatsapp.net') {
  return {
    key:     { remoteJid: jid, id: 'msg-id' },
    message: withMessageField ? { conversation: 'olá' } : undefined,
  };
}

// ── Testes ─────────────────────────────────────────────────────────────────────

describe('routeMessages — roteamento de mensagens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama MessageHandler.process para mensagem válida do tipo notify', async () => {
    const upsert = makeUpsert([makeMessage()]);
    await routeMessages(mockSock, upsert);

    expect(MessageHandler.process).toHaveBeenCalledTimes(1);
  });

  it('NÃO processa mensagens com type diferente de notify', async () => {
    const upsert = makeUpsert([makeMessage()], 'append');
    await routeMessages(mockSock, upsert);

    expect(MessageHandler.process).not.toHaveBeenCalled();
  });

  it('NÃO processa mensagem sem campo message', async () => {
    const upsert = makeUpsert([makeMessage(false)]);
    await routeMessages(mockSock, upsert);

    expect(MessageHandler.process).not.toHaveBeenCalled();
  });

  it('processa múltiplas mensagens válidas em sequência', async () => {
    const upsert = makeUpsert([makeMessage(), makeMessage()]);
    await routeMessages(mockSock, upsert);

    expect(MessageHandler.process).toHaveBeenCalledTimes(2);
  });

  it('mensagens mistas: processa apenas as que têm message field', async () => {
    const upsert = makeUpsert([
      makeMessage(true),
      makeMessage(false),
      makeMessage(true),
    ]);
    await routeMessages(mockSock, upsert);

    expect(MessageHandler.process).toHaveBeenCalledTimes(2);
  });

  it('captura erros sem propagar exceção', async () => {
    MessageHandler.process.mockRejectedValueOnce(new Error('falha inesperada'));

    const upsert = makeUpsert([makeMessage()]);
    await expect(routeMessages(mockSock, upsert)).resolves.not.toThrow();
  });

  it('passa o sock e a mensagem corretamente ao BaileysAdapter', async () => {
    const { BaileysAdapter } = await import('../../../src/adapters/BaileysAdapter.js');

    const msg    = makeMessage();
    const upsert = makeUpsert([msg]);

    await routeMessages(mockSock, upsert);

    const [adapterArg] = MessageHandler.process.mock.calls[0];
    expect(adapterArg).toBeInstanceOf(BaileysAdapter);
    expect(adapterArg.sock).toBe(mockSock);
    expect(adapterArg.message).toBe(msg);
  });

  it('encaminha o jid correto para o BaileysAdapter', async () => {
    const msg    = makeMessage(true, 'grupo123@g.us');
    const upsert = makeUpsert([msg]);

    await routeMessages(mockSock, upsert);

    const [adapterArg] = MessageHandler.process.mock.calls[0];
    expect(adapterArg.jid).toBe('grupo123@g.us');
  });
});
