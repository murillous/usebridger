// M7-4 (ADR 0128): a permissão efetiva da API key é o escopo dela ∩ as permissões atuais do criador.

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { createActorResolver } from './actor.ts';
import { createAuthStore } from './store.ts';

async function setup() {
  const store = createAuthStore(kernelStorage(createMemoryStorage(), 'auth'));
  const now = new Date();
  const userId = await store.createUser(
    { name: 'ana', email: 'ana@x.dev', passwordHash: 'h', role: 'admin' },
    now,
  );
  const key = await store.createApiKey(
    { name: 'ci', permissions: ['logs.read', 'keys.manage'], createdBy: userId },
    now,
  );
  const resolve = createActorResolver({ store });
  const as = (secret: string) =>
    resolve(new Request('http://x/', { headers: { authorization: `Bearer ${secret}` } }));
  return { store, userId, key, as };
}

describe('escopo da API key limitado ao criador', () => {
  it('criador rebaixado: a chave perde o que ele não tem mais', async () => {
    const { store, userId, key, as } = await setup();
    expect((await as(key.secret))?.permissions).toEqual(['logs.read', 'keys.manage']);
    await store.updateUser(userId, { role: 'viewer' });
    expect((await as(key.secret))?.permissions).toEqual(['logs.read']);
    expect((await store.getApiKey(key.id))?.permissions).toEqual(['logs.read', 'keys.manage']);
  });

  it('criador desativado: sem ator; reativado: volta', async () => {
    const { store, userId, key, as } = await setup();
    await store.updateUser(userId, { status: 'disabled' });
    expect(await as(key.secret)).toBeUndefined();
    await store.updateUser(userId, { status: 'active' });
    expect((await as(key.secret))?.permissions).toEqual(['logs.read', 'keys.manage']);
  });

  it('criador inexistente: sem ator; sem criador: vale o escopo da chave', async () => {
    const { store, as } = await setup();
    const orphan = await store.createApiKey(
      { name: 'o', permissions: ['logs.read'], createdBy: 'sumiu' },
      new Date(),
    );
    expect(await as(orphan.secret)).toBeUndefined();
    const free = await store.createApiKey({ name: 'f', permissions: ['logs.read'] }, new Date());
    expect((await as(free.secret))?.permissions).toEqual(['logs.read']);
  });

  it('chave criada por chave segue a cadeia', async () => {
    const { store, userId, key, as } = await setup();
    const child = await store.createApiKey(
      { name: 'filha', permissions: ['logs.read', 'keys.manage'], createdBy: key.id },
      new Date(),
    );
    await store.updateUser(userId, { role: 'viewer' });
    expect((await as(child.secret))?.permissions).toEqual(['logs.read']);
    await store.revokeApiKey(key.id, new Date());
    expect(await as(child.secret)).toBeUndefined();
  });

  it('criador-raiz desativado: a chave-filha dá 401', async () => {
    const { store, userId, key, as } = await setup();
    const child = await store.createApiKey(
      { name: 'filha', permissions: ['logs.read'], createdBy: key.id },
      new Date(),
    );
    await store.updateUser(userId, { status: 'disabled' });
    expect(await as(child.secret)).toBeUndefined();
  });

  it('chave-pai ausente: 401', async () => {
    const { store, as } = await setup();
    const child = await store.createApiKey(
      { name: 'filha', permissions: ['logs.read'], createdBy: 'brk-fantasma' },
      new Date(),
    );
    expect(await as(child.secret)).toBeUndefined();
  });

  it('ciclo forjado no storage: não autentica e não estoura a pilha', async () => {
    const { store, key } = await setup();
    const b = await store.createApiKey(
      { name: 'b', permissions: ['logs.read'], createdBy: key.id },
      new Date(),
    );
    // Só edição direta do storage produz o ciclo: a chave original passa a ser filha da filha.
    const doc = await store.getApiKey(key.id);
    if (doc === undefined) throw new Error('sumiu');
    (doc as { createdBy: string | null }).createdBy = b.id;
    const patched = {
      ...store,
      getApiKey: async (id: string) => (id === key.id ? doc : store.getApiKey(id)),
    };
    const resolve = createActorResolver({ store: patched });
    const res = await resolve(
      new Request('http://x/', { headers: { authorization: `Bearer ${b.secret}` } }),
    );
    expect(res).toBeUndefined();
  });
});
