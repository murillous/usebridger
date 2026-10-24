import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import type { Collection, JsonValue, StoragePort } from '#storage/types.ts';
import { currentTrace, runInTrace } from '#trace/scope.ts';
import { createSchedulerService, type SchedulerService } from './service.ts';

const T0 = Date.UTC(2026, 0, 1);
let service: SchedulerService | undefined;

afterEach(async () => {
  await service?.stop();
  vi.useRealTimers();
});

describe('scheduler e trace', () => {
  it('falha de storage no loop não herda o trace da mensagem que agendou', async () => {
    vi.useFakeTimers({ now: T0 });
    const port = createMemoryStorage();
    const real = kernelStorage(port, 'scheduler').collection('jobs');
    let failures = 1;
    const flaky: StoragePort = {
      ...port,
      forNamespace(namespace) {
        const storage = port.forNamespace(namespace);
        return {
          kv: storage.kv,
          collection: <T extends { readonly [key: string]: JsonValue }>() => {
            const c = real as unknown as Collection<T>;
            return {
              ...c,
              find: async (query) => {
                if (failures > 0) {
                  failures--;
                  throw new Error('storage fora');
                }
                return c.find(query);
              },
            };
          },
        };
      },
    };
    const seen: (string | undefined)[] = [];
    const svc = createSchedulerService({
      storage: flaky,
      onError: () => undefined,
      onStorageError: () => seen.push(currentTrace()),
      jobTimeoutMs: 1000,
      storageRetryMs: 1000,
    });
    service = svc;
    svc.forPlugin('p').on('j', () => undefined);
    svc.start();
    // Agenda dentro de uma mensagem: o timer armado aqui não pode levar o trace dela.
    await runInTrace('a'.repeat(32), () => svc.forPlugin('p').at(T0 + 500, 'j'));
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([undefined]);
  });
});
