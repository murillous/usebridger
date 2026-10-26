import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from './index.ts';

const run = promisify(execFile);
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridger-sqlite-'));
  file = join(dir, 'bot.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// `bridger owner-invite` roda com o bot no ar (M7-4, ADR 0128): são dois processos no mesmo
// arquivo, e a CLI só grava documentos de auth com operações atômicas, sem a trava da sessão.
describe('sqlite: owner-invite com o bot no ar (M7-4)', () => {
  it('a CLI grava usuário e convite enquanto outro processo escreve no arquivo, sem SQLITE_BUSY', async () => {
    // Abre antes para o schema existir quando os dois processos disputarem o arquivo.
    const cli = sqlite({ path: file });
    const script = fileURLToPath(new URL('./bot-simulado.ts', import.meta.url));
    const bot = run(process.execPath, ['--conditions=@usebridger/source', script, file, '300']);

    // O que `recoverOwner` faz no storage: cria o usuário, grava o convite e o consome com um
    // `update` condicional (uso único); duas tentativas simultâneas, uma só vence.
    const auth = cli.forNamespace('$auth');
    const users = auth.collection<{ email: string; role: string }>('users');
    const invites = auth.collection<{ userId: string; used: boolean }>('invites');
    for (let i = 0; i < 100; i++) {
      const userId = await users.insert({ email: `dona${i}@exemplo.com`, role: 'owner' });
      const inviteId = await invites.insert({ userId, used: false });
      const claims = await Promise.all([
        invites.update({ id: inviteId, used: false }, { used: true }),
        invites.update({ id: inviteId, used: false }, { used: true }),
      ]);
      expect(claims[0] + claims[1]).toBe(1);
    }
    await bot;
    await cli.close();

    // Cada lado enxerga o que o outro gravou.
    const again = sqlite({ path: file });
    const seen = again.forNamespace('$auth');
    expect(await seen.collection('sessions').find({ limit: 1000 })).toHaveLength(300);
    expect(await seen.collection('users').find({ limit: 1000 })).toHaveLength(100);
    await again.close();
  }, 30_000);
});
