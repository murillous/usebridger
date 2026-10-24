// ADR 0119: nenhum lid, JID ou telefone cru na saída do logger do bot, venha ele do transport
// ou de uma linha repassada da biblioteca.

import { createLogger, createMemoryStorage, type LogDestination } from '@usebridger/core';
import type { TransportDeps } from '@usebridger/core/adapter';
import { describe, expect, it, vi } from 'vitest';
import { FakeDriver } from './fake-socket.test-support.ts';
import { toBaileysLogger } from './logger.ts';
import { BaileysTransport } from './transport.ts';

const RAW = /@lid|@s\.whatsapp\.net|@g\.us|5511999998888/;

function capture() {
  const out: string[] = [];
  const destination: LogDestination = { write: (line) => out.push(line) };
  return { out, log: createLogger({ level: 'trace', destination }) };
}

describe('privacidade dos logs do transport-baileys', () => {
  it('falha ao resolver o LID não deixa lid nem telefone na linha', async () => {
    const { out, log } = capture();
    const driver = new FakeDriver();
    const deps: TransportDeps = {
      session: 'default',
      auth: createMemoryStorage().authState('default'),
      log,
    };
    const transport = new BaileysTransport({ pairing: 'qr', driver }, deps);
    const seen: unknown[] = [];
    transport.on('message', (m) => {
      seen.push(m);
    });
    await transport.connect();
    const socket = driver.last;
    socket.signalRepository.lidMapping.getPNForLID = () =>
      Promise.reject(new Error('sem par para 123456789@lid (5511999998888@s.whatsapp.net)'));
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '120363000000000001@g.us', id: 'M1', participant: '123456789@lid' },
          message: { conversation: 'oi' },
        },
      ],
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(out.find((line) => line.includes('baileys.lid.resolve-failed'))).toBeDefined();
    expect(out.join('\n')).not.toMatch(RAW);
  });

  it('linha repassada da biblioteca com JID e telefone sai redigida', () => {
    const { out, log } = capture();
    const baileys = toBaileysLogger(log);
    baileys.info(
      { jid: '5511999998888@s.whatsapp.net', to: '5511999998888' },
      'sent to 5511999998888',
    );
    baileys.warn({ participant: '123456789@lid' }, 'participante 123456789@lid saiu');
    expect(out).toHaveLength(2);
    expect(out.join('\n')).not.toMatch(RAW);
    expect(out[0]).toContain('[REDACTED]');
  });
});
