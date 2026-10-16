import { ping } from '@usebridger/example-primeiro-bot/ping';
import { createTestBot } from '@usebridger/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { cadastro } from './cadastro.ts';

afterEach(() => vi.useRealTimers());

// #region teste
it('pergunta o nome, depois a cidade, e confirma', async () => {
  const bot = await createTestBot({ plugins: [cadastro] });

  await bot.receive({ text: '!cadastro' });
  await bot.receive({ text: 'Ana' });
  await bot.receive({ text: 'Recife' });

  expect(bot.sent).toContainText('Prazer, Ana! De que cidade você é?');
  expect(bot.sent).toContainText('Cadastro feito: Ana, de Recife.');
  await bot.stop();
});
// #endregion teste

it('um comando no meio cancela a conversa', async () => {
  const bot = await createTestBot({ plugins: [cadastro, ping] });

  await bot.receive({ text: '!cadastro' });
  await bot.receive({ text: '!ping' });
  await bot.receive({ text: 'Ana' });

  expect(bot.sent).toContainText('pong');
  expect(bot.sent).not.toContainText(/Prazer/);
  await bot.stop();
});

it('"cancelar" é tratado pelo passo', async () => {
  const bot = await createTestBot({ plugins: [cadastro] });

  await bot.receive({ text: '!cadastro' });
  await bot.receive({ text: 'cancelar' });

  expect(bot.sent).toContainText('Ok, cancelado.');
  await bot.stop();
});

it('avisa quando a pessoa para de responder na cidade', async () => {
  // Antes do createTestBot: a espera arma o timer no relógio que vale no `expectReply`.
  vi.useFakeTimers();
  const bot = await createTestBot({ plugins: [cadastro] });

  await bot.receive({ text: '!cadastro' });
  await bot.receive({ text: 'Ana' });
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  await bot.bot.settled();

  expect(bot.sent).toContainText(/Encerrei o cadastro/);
  await bot.stop();
});

it('sem resposta ao nome, a espera some em silêncio', async () => {
  vi.useFakeTimers();
  const bot = await createTestBot({ plugins: [cadastro] });

  await bot.receive({ text: '!cadastro' });
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  await bot.bot.settled();
  await bot.receive({ text: 'Ana' });

  expect(bot.sent).toHaveLength(1);
  await bot.stop();
});
