import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from './index.ts';

// `bridger owner-invite` com o bot no ar (M7-4, ADR 0128): a CLI real roda num processo filho,
// sobre o mesmo arquivo SQLite que o "bot" (este processo) mantém aberto e escrevendo.
const bin = fileURLToPath(new URL('./cli/bridger-bin.ts', import.meta.resolve('@usebridger/core')));
const adapter = new URL('./index.ts', import.meta.url).href;

let dir: string;
let file: string;
let module: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridger-owner-invite-'));
  file = join(dir, 'bot.sqlite');
  module = join(dir, 'storage.ts');
  writeFileSync(
    module,
    `import { sqlite } from ${JSON.stringify(adapter)};\nexport const storage = sqlite({ path: ${JSON.stringify(file)} });\n`,
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function bot() {
  const port = sqlite({ path: file });
  cleanups.push(() => port.close());
  const auth = port.forNamespace('$auth');
  return {
    sessions: auth.collection<{ hash: string; userId: string }>('sessions', {
      indexes: ['hash', 'userId'],
    }),
    users: auth.collection<{ role: string; status: string }>('users', { indexes: ['email'] }),
    invites: auth.collection<{ userId: string }>('invites', { indexes: ['hash', 'userId'] }),
    locks: auth.collection<{ key: string; until: number }>('locks', { indexes: ['key'] }),
  };
}

interface Finished {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Roda a CLI; `state.exited` vira true quando o filho sai. O `timeout` mata o filho se travar e
// o cleanup do teste o mata de qualquer forma, para não deixar processo órfão.
function runCli(args: readonly string[]) {
  const state = { exited: false };
  const result = new Promise<Finished>((done) => {
    const child = execFile(
      process.execPath,
      ['--conditions=@usebridger/source', bin, 'owner-invite', module, ...args],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        state.exited = true;
        done({ code: error === null ? 0 : (child.exitCode ?? 1), stdout, stderr });
      },
    );
    cleanups.push(() => {
      child.kill();
    });
  });
  return { state, result };
}

const ARGS = ['--email', 'dona@exemplo.com', '--name', 'Dona'] as const;

describe('sqlite: owner-invite com o bot no ar (M7-4)', () => {
  it('a CLI cria o owner e o convite enquanto o bot grava no mesmo arquivo', async () => {
    const { sessions, users, invites } = bot();
    const cli = runCli(ARGS);

    let written = 0;
    while (!cli.state.exited) {
      await sessions.insert({ hash: `h${written}`, userId: 'u' });
      written++;
      // O driver é síncrono: sem ceder o laço de eventos, a saída do filho nunca seria vista.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const { code, stdout, stderr } = await cli.result;

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toMatch(/bri_/);
    expect(written).toBeGreaterThan(0);
    // Nenhuma escrita do bot se perdeu, e o que a CLI gravou aparece para ele.
    expect(await sessions.find({ limit: 1_000_000 })).toHaveLength(written);
    const owners = await users.find({ where: { role: 'owner' } });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ status: 'active' });
    expect(await invites.find({ where: { userId: owners[0]?.id as string } })).toHaveLength(1);
  }, 90_000);

  it('com a trava `users` em poder do bot, a CLI espera e termina com um owner só', async () => {
    const { users, locks } = bot();
    await locks.insert({ key: 'users', until: Date.now() + 60_000 });
    const cli = runCli(ARGS);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(cli.state.exited).toBe(false);
    // Solta a trava como o bot soltaria ao fim da operação dele.
    await locks.update({ key: 'users' }, { until: 0 });
    const { code } = await cli.result;
    expect(code).toBe(0);
    expect(await users.find({ where: { role: 'owner' } })).toHaveLength(1);
  }, 90_000);

  it('com a trava presa, a CLI sai com erro claro e não cria owner', async () => {
    const { users, locks } = bot();
    await locks.insert({ key: 'users', until: Date.now() + 120_000 });
    const { code, stderr } = await runCli(ARGS).result;
    expect(code).toBe(1);
    expect(stderr).toMatch(/em uso por outra operação/);
    expect(await users.find({ where: { role: 'owner' } })).toHaveLength(0);
  }, 90_000);
});
