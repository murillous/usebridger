import { describe, expect, it } from 'vitest';
import type { Audit } from '#audit/audit.ts';
import { createApiGuard } from '#auth/guard.ts';
import { createAuthStore } from '#auth/store.ts';
import { createNoopLogger } from '#logger/logger.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { kernelStorage } from '#storage/namespace.ts';
import { createHttp, sessionHttp } from './server.ts';

const guard = () =>
  createApiGuard({
    store: createAuthStore(kernelStorage(createMemoryStorage(), 'auth')),
    audit: () => ({}) as unknown as Audit,
  });

describe('API sem auth só em loopback (M7-4, ADR 0128)', () => {
  it.each([undefined, '0.0.0.0', '::', '192.168.0.5'])('recusa %s sem api.auth', (hostname) => {
    const http = createHttp({ port: 0, ...(hostname !== undefined && { hostname }) });
    expect(() => sessionHttp(http, 'default', createNoopLogger)).toThrow(/api\.auth/);
  });

  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost'])(
    'aceita %s sem api.auth',
    (hostname) => {
      const http = createHttp({ port: 0, hostname });
      expect(() => sessionHttp(http, 'default', createNoopLogger)).not.toThrow();
    },
  );

  it('aceita 0.0.0.0 e hostname ausente com api.auth', () => {
    for (const hostname of [undefined, '0.0.0.0']) {
      const http = createHttp({ port: 0, ...(hostname !== undefined && { hostname }) });
      expect(() =>
        sessionHttp(http, 'default', createNoopLogger, undefined, { auth: {} }, guard()),
      ).not.toThrow();
    }
  });
});
