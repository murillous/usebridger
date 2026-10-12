import { describe, expect, it } from 'vitest';
import { BackgroundTasks } from './background-tasks.ts';

/** Diz se a promessa já assentou, depois de esvaziar as microtarefas pendentes. */
async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe('BackgroundTasks', () => {
  it('sem tarefas, o idle resolve na hora', async () => {
    const tasks = new BackgroundTasks();
    expect(tasks.size).toBe(0);
    expect(await isSettled(tasks.idle())).toBe(true);
  });

  it('o idle espera todas as tarefas assentarem, inclusive as rejeitadas', async () => {
    const tasks = new BackgroundTasks();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    tasks.track(first.promise);
    tasks.track(second.promise.catch(() => undefined));
    expect(tasks.size).toBe(2);

    const idle = tasks.idle();
    first.resolve();
    expect(await isSettled(idle)).toBe(false);
    expect(tasks.size).toBe(1);

    second.reject(new Error('falhou'));
    expect(await isSettled(idle)).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it('o clear esquece as tarefas e solta quem espera', async () => {
    const tasks = new BackgroundTasks();
    const stuck = Promise.withResolvers<void>();
    tasks.track(stuck.promise);
    const idle = tasks.idle();

    tasks.clear();
    expect(tasks.size).toBe(0);
    expect(await isSettled(idle)).toBe(true);
    expect(await isSettled(tasks.idle())).toBe(true);
  });
});
