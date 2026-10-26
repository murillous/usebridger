import { randomUUID } from 'node:crypto';
import type { StoragePort } from '@usebridger/core/adapter';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_POSTGRES_URL } from './config/test-env.ts';
import { postgres } from './index.ts';

// `bridger owner-invite` roda com o bot no ar (M7-4, ADR 0128): dois clientes no mesmo banco, e a
// CLI só grava documentos de auth com operações atômicas, sem a trava da sessão.
describe.skipIf(TEST_POSTGRES_URL === undefined)('postgres: owner-invite com o bot no ar', () => {
  const connectionString = TEST_POSTGRES_URL as string;
  let schema: string;
  const open: StoragePort[] = [];

  async function connect(): Promise<StoragePort> {
    const port = await postgres({ connectionString, schema });
    open.push(port);
    return port;
  }

  beforeEach(() => {
    schema = `t_${randomUUID().replaceAll('-', '')}`;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((port) => port.close()));
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  it('a CLI grava usuário e convite enquanto o bot escreve, e cada lado vê o do outro', async () => {
    const [bot, cli] = await Promise.all([connect(), connect()]);
    const sessions = bot.forNamespace('$auth').collection('sessions');
    const auth = cli.forNamespace('$auth');
    const users = auth.collection<{ email: string; role: string }>('users');
    const invites = auth.collection<{ userId: string; used: boolean }>('invites');

    const botWrites = (async () => {
      for (let i = 0; i < 100; i++) await sessions.insert({ n: i });
    })();
    for (let i = 0; i < 30; i++) {
      const userId = await users.insert({ email: `dona${i}@exemplo.com`, role: 'owner' });
      const inviteId = await invites.insert({ userId, used: false });
      // Uso único: duas tentativas simultâneas de consumir, uma só vence.
      const claims = await Promise.all([
        invites.update({ id: inviteId, used: false }, { used: true }),
        invites.update({ id: inviteId, used: false }, { used: true }),
      ]);
      expect(claims[0] + claims[1]).toBe(1);
    }
    await botWrites;

    expect(await bot.forNamespace('$auth').collection('users').find({ limit: 1000 })).toHaveLength(
      30,
    );
    expect(await auth.collection('sessions').find({ limit: 1000 })).toHaveLength(100);
  });
});
