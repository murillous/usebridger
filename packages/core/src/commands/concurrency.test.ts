// Teto de execuções simultâneas de um comando (ADR 0088).

import { describe, expect, it } from 'vitest';
import { deferred } from '#bot/harness.test-support.ts';
import { createConcurrencyLimit } from './concurrency.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createConcurrencyLimit', () => {
  it('roda até o teto e o resto espera, em ordem de chegada', async () => {
    const limit = createConcurrencyLimit(2);
    const signal = new AbortController().signal;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const results = gates.map((gate, i) =>
      limit.run(() => {
        started.push(i);
        return gate.promise;
      }, signal),
    );

    await flush();
    expect(started).toEqual([0, 1]);

    gates[1]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[0]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    for (const gate of gates) gate.resolve();
    await Promise.all(results);
  });

  it('tarefa síncrona, que lança ou que rejeita devolve a vaga', async () => {
    const limit = createConcurrencyLimit(1);
    const signal = new AbortController().signal;

    expect(limit.run(() => 'ok', signal)).toBe('ok');
    expect(() =>
      limit.run(() => {
        throw new Error('síncrono');
      }, signal),
    ).toThrow('síncrono');
    await expect(limit.run(() => Promise.reject(new Error('assíncrono')), signal)).rejects.toThrow(
      'assíncrono',
    );
    expect(limit.run(() => 'livre', signal)).toBe('livre');
  });

  it('signal abortado na espera tira da fila e rejeita com o reason, sem rodar', async () => {
    const limit = createConcurrencyLimit(1);
    const busy = deferred();
    limit.run(() => busy.promise, new AbortController().signal);

    const controller = new AbortController();
    let ran = false;
    const waiting = limit.run(() => {
      ran = true;
    }, controller.signal);
    const reason = new Error('prazo');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    // A vaga não foi para quem desistiu: o próximo roda quando a ocupada volta.
    let next = false;
    const after = limit.run(() => {
      next = true;
    }, new AbortController().signal);
    busy.resolve();
    await after;
    expect(next).toBe(true);
    expect(ran).toBe(false);
  });

  it('signal já abortado sem vaga rejeita na hora', async () => {
    const limit = createConcurrencyLimit(1);
    limit.run(() => new Promise(() => undefined), new AbortController().signal);
    const reason = new Error('descartado');

    await expect(limit.run(() => undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});
