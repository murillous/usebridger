// Registro de conversas: o `expire`, ponto único de expiração de uma espera (ADR 0093).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Contact } from '#message/types.ts';
import { ConversationRegistry } from './conversations.ts';

const chat: Chat = { id: 'chat@test', isGroup: false };
const ana: Contact = { id: 'ana@test', name: 'Ana', phone: null };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConversationRegistry.expire (ADR 0093)', () => {
  it('só retira a espera que venceu, e devolve o onExpire com chat, remetente e data', () => {
    const registry = new ConversationRegistry<unknown, string>();
    const onExpire = vi.fn();
    registry.define('p', 'passo', () => undefined, onExpire);
    registry.expect('p', chat, ana, 'passo', { data: { n: 1 }, ttlMs: 1000 });

    expect(registry.expire(chat.id, ana.id)).toBeUndefined();

    // Relógio adiantado sem disparar o timer: o caso da espera restaurada que venceu no restart.
    vi.setSystemTime(Date.now() + 1000);
    const expired = registry.expire(chat.id, ana.id);

    expect(expired).toMatchObject({
      plugin: 'p',
      step: 'passo',
      data: { n: 1 },
      chat,
      sender: ana,
    });
    expect(expired?.run).toBe(onExpire);
    expect(registry.take(chat.id, ana.id)).toBeUndefined();
    expect(registry.expire(chat.id, ana.id)).toBeUndefined();
  });

  it('o timer avisa onDue sem retirar a espera; quem chega antes (take ou expire) leva', () => {
    const onDue = vi.fn();
    const registry = new ConversationRegistry<unknown, string>({ onDue });
    registry.define(
      'p',
      'passo',
      () => undefined,
      () => undefined,
    );
    registry.expect('p', chat, ana, 'passo', { ttlMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(onDue).toHaveBeenCalledWith(chat, ana);
    expect(registry.take(chat.id, ana.id)).toMatchObject({ step: 'passo' });
    expect(registry.expire(chat.id, ana.id)).toBeUndefined();
  });

  it('passo sem onExpire: o timer não avisa, e a espera vencida some em silêncio', () => {
    const onDue = vi.fn();
    const registry = new ConversationRegistry<unknown, string>({ onDue });
    registry.define('p', 'passo', () => undefined);
    registry.expect('p', chat, ana, 'passo', { ttlMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(onDue).not.toHaveBeenCalled();
    expect(registry.take(chat.id, ana.id)).toBeUndefined();
  });

  it('não expira a espera nova que substituiu a vencida', () => {
    const onDue = vi.fn();
    const registry = new ConversationRegistry<unknown, string>({ onDue });
    registry.define(
      'p',
      'passo',
      () => undefined,
      () => undefined,
    );
    registry.expect('p', chat, ana, 'passo', { ttlMs: 1000 });
    vi.advanceTimersByTime(1000);

    registry.expect('p', chat, ana, 'passo', { ttlMs: 1000 });

    expect(registry.expire(chat.id, ana.id)).toBeUndefined();
    expect(registry.take(chat.id, ana.id)).toMatchObject({ step: 'passo' });
  });
});
