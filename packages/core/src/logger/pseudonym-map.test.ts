// ADR 0132: mapa reverso pseudônimo → id, cifrado no storage.

import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SecretKeys } from '#config/env.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import type { KeyValueStore } from '#storage/types.ts';
import { createPseudonymizer } from './pseudonym.ts';
import { createPseudonymMap } from './pseudonym-map.ts';

const ID = '5565999998888@s.whatsapp.net';

function setup(keys: SecretKeys, kv?: KeyValueStore) {
  const store = kv ?? createMemoryStorage().forNamespace('t').kv;
  const onError = vi.fn();
  const map = createPseudonymMap({ kv: () => store, keys: () => keys, onError });
  const { pseudonym } = createPseudonymizer(() => keys.current, map.remember);
  return { map, pseudonym, store, onError };
}

describe('mapa reverso do pseudônimo', () => {
  it('o pseudônimo calculado resolve de volta ao id; o storage só tem o envelope', async () => {
    const { map, pseudonym, store } = setup({ current: randomBytes(32), previous: undefined });
    const value = pseudonym(ID);
    await vi.waitFor(async () => expect(await map.resolve(value)).toBe(ID));
    expect(JSON.stringify(await store.get(value))).not.toContain('5565999998888');
    expect(await map.resolve('u_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
  });

  it('grava uma vez por pseudônimo no processo', async () => {
    const inner = createMemoryStorage().forNamespace('t').kv;
    const set = vi.fn(inner.set);
    const { pseudonym } = setup(
      { current: randomBytes(32), previous: undefined },
      { ...inner, set },
    );
    pseudonym(ID);
    pseudonym(ID);
    pseudonym('outro@lid');
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('sem chave mestra não grava nada nem resolve', async () => {
    const { map, pseudonym, store } = setup({ current: undefined, previous: undefined });
    const value = pseudonym(ID);
    expect(map.enabled).toBe(false);
    expect(await store.get(value)).toBeUndefined();
    expect(await map.resolve(value)).toBeUndefined();
  });

  it('depois da rotação, a chave anterior ainda decifra o que foi gravado antes', async () => {
    const old = randomBytes(32);
    const store = createMemoryStorage().forNamespace('t').kv;
    const before = setup({ current: old, previous: undefined }, store);
    const value = before.pseudonym(ID);
    await vi.waitFor(async () => expect(await before.map.resolve(value)).toBe(ID));
    const rotated = setup({ current: randomBytes(32), previous: old }, store);
    expect(await rotated.map.resolve(value)).toBe(ID);
    const lost = setup({ current: randomBytes(32), previous: undefined }, store);
    expect(await lost.map.resolve(value)).toBeUndefined();
  });

  it('falha de gravação vai para o onError e o par é tentado de novo', async () => {
    const inner = createMemoryStorage().forNamespace('t').kv;
    const set = vi
      .fn()
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockImplementation(inner.set);
    const { pseudonym, onError, map } = setup(
      { current: randomBytes(32), previous: undefined },
      { ...inner, set },
    );
    const value = pseudonym(ID);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    pseudonym(ID);
    await vi.waitFor(async () => expect(await map.resolve(value)).toBe(ID));
  });
});
