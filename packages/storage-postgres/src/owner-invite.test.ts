import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoragePort } from '@usebridger/core/adapter';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_POSTGRES_URL } from './config/test-env.ts';
import { postgres } from './index.ts';

// `bridger owner-invite` com o bot no ar (M7-4, ADR 0128): o `main` real da CLI roda neste
// processo com o próprio cliente, e o "bot" é um segundo cliente no mesmo banco.
const bridger = new URL('./cli/bridger.ts', import.meta.resolve('@usebridger/core')).href;
const adapter = new URL('./index.ts', import.meta.url).href;

describe.skipIf(TEST_POSTGRES_URL === undefined)('postgres: owner-invite com o bot no ar', () => {
  const connectionString = TEST_POSTGRES_URL as string;
  let schema: string;
  let dir: string;
  let module: string;
  const open: StoragePort[] = [];

  async function runCli() {
    const { main } = (await import(bridger)) as {
      main: (
        argv: readonly string[],
        io: { out: (text: string) => void; err: (text: string) => void },
      ) => Promise<number>;
    };
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ['owner-invite', module, '--email', 'dona@exemplo.com', '--name', 'Dona'],
      {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  beforeEach(() => {
    schema = `t_${randomUUID().replaceAll('-', '')}`;
    dir = mkdtempSync(join(tmpdir(), 'bridger-owner-invite-'));
    module = join(dir, 'storage.ts');
    writeFileSync(
      module,
      `import { postgres } from ${JSON.stringify(adapter)};\n` +
        `export const storage = await postgres({ connectionString: ${JSON.stringify(connectionString)}, schema: ${JSON.stringify(schema)} });\n`,
    );
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((port) => port.close()));
    rmSync(dir, { recursive: true, force: true });
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  async function bot() {
    const port = await postgres({ connectionString, schema });
    open.push(port);
    const auth = port.forNamespace('$auth');
    return {
      sessions: auth.collection<{ hash: string; userId: string }>('sessions', {
        indexes: ['hash', 'userId'],
      }),
      users: auth.collection<{ role: string; status: string }>('users', { indexes: ['email'] }),
      locks: auth.collection<{ key: string; until: number }>('locks', { indexes: ['key'] }),
    };
  }

  it('a CLI cria o owner enquanto o bot grava, e nenhuma escrita se perde', async () => {
    const { sessions, users } = await bot();
    let stop = false;
    let written = 0;
    const writing = (async () => {
      while (!stop) await sessions.insert({ hash: `h${written++}`, userId: 'u' });
    })();
    const { code, out, err } = await runCli();
    stop = true;
    await writing;

    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/bri_/);
    expect(written).toBeGreaterThan(0);
    expect(await sessions.find({ limit: 1_000_000 })).toHaveLength(written);
    expect(await users.find({ where: { role: 'owner' } })).toHaveLength(1);
  }, 60_000);

  it('com a trava `users` presa pelo bot, a CLI sai com erro claro e não cria owner', async () => {
    const { users, locks } = await bot();
    await locks.insert({ key: 'users', until: Date.now() + 120_000 });
    const { code, err } = await runCli();
    expect(code).toBe(1);
    expect(err).toMatch(/em uso por outra operação/);
    expect(await users.find({ where: { role: 'owner' } })).toHaveLength(0);
  }, 60_000);
});
