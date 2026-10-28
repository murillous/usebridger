import { createHttp } from '@usebridger/core';
import { createTestBot, PROFILE_NAMES, PROFILES } from '@usebridger/testing';
import { describe, expect, it } from 'vitest';
import { __export__ } from './index.ts';

// O mesmo teste em todas as plataformas do kit: cada perfil traz as capabilities e o remetente
// da plataforma, e um plugin que só passa no WhatsApp falha aqui.
describe.each(PROFILE_NAMES)('no %s', (profile) => {
  it('!ola cumprimenta quem chamou pelo nome', async () => {
    const bot = await createTestBot({ profile, plugins: [__export__] });

    await bot.receive({ text: '!ola', sender: { name: 'Ana' } });

    expect(bot.sent).toContainText('Olá, Ana!');
    await bot.stop();
  });

  it('reage só onde a plataforma tem reação', async () => {
    const bot = await createTestBot({ profile, plugins: [__export__] });

    await bot.receive({ text: '!ola' });

    const reacts = PROFILES[profile].capabilities.includes('reactions');
    expect(bot.transport.reactions).toHaveLength(reacts ? 1 : 0);
    await bot.stop();
  });
});

describe('recurso saudacoes na API', () => {
  it('lista quantas vezes cada pessoa foi cumprimentada', async () => {
    // Porta livre em loopback: sem `api.auth`, a API só sobe assim.
    const http = createHttp({ port: 0, hostname: '127.0.0.1' });
    const bot = await createTestBot({ http, plugins: [__export__] });

    await bot.receive({ text: '!ola', sender: { name: 'Ana' } });
    await bot.receive({ text: '!ola', sender: { name: 'Ana' } });
    await bot.receive({ text: '!ola', sender: { name: 'Bia' } });

    const res = await fetch(`http://127.0.0.1:${http.port}/api/resources/__name__/saudacoes`);
    expect(await res.json()).toEqual({
      items: [
        expect.objectContaining({ pessoa: 'Ana', vezes: 2 }),
        expect.objectContaining({ pessoa: 'Bia', vezes: 1 }),
      ],
    });
    await bot.stop();
  });
});
