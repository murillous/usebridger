import { afterEach, describe, expect, it } from 'vitest';
import { createNoopLogger } from '#logger/logger.ts';
import { createHttp, type SessionHttp, sessionHttp, withTraceparent } from './server.ts';

const attached: SessionHttp[] = [];
const ID = '4bf92f3577b34da6a3ce929d0e0e4736';

afterEach(async () => {
  for (const session of attached.splice(0)) await session.detach();
});

async function serve(handler: () => Response): Promise<string> {
  const http = createHttp({ port: 0, hostname: '127.0.0.1' });
  const session = sessionHttp(http, 'default', createNoopLogger);
  session
    .scope(
      'api',
      () => '/plugins/api',
      () => undefined,
    )
    .route('GET', '/x', handler);
  session.attach(() => 'running');
  attached.push(session);
  await session.listen();
  return `http://127.0.0.1:${http.port}/plugins/api/x`;
}

describe('traceparent da resposta', () => {
  it('HTTP 500 do handler que lança continua devolvendo o header', async () => {
    const url = await serve(() => {
      throw new Error('quebrou');
    });
    const response = await fetch(url);
    expect(response.status).toBe(500);
    expect(response.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('Response.redirect (headers imutáveis) recebe o header', async () => {
    const url = await serve(() => Response.redirect('http://127.0.0.1/destino', 302));
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/);
  });

  it('withTraceparent: mutável, imutável e irreparável', () => {
    const mutable = new Response('x');
    expect(withTraceparent(mutable, ID)).toBe(mutable);
    expect(mutable.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/);

    // Response.redirect tem headers mutáveis no Node; simula o `immutable` de um `fetch` repassado.
    const redirect = Response.redirect('http://127.0.0.1/d', 302);
    Object.defineProperty(redirect, 'headers', {
      value: {
        set: () => {
          throw new TypeError('immutable');
        },
        [Symbol.iterator]: () => [][Symbol.iterator](),
      },
    });
    const copy = withTraceparent(redirect, ID, '00');
    expect(copy).not.toBe(redirect);
    expect(copy.status).toBe(302);
    expect(copy.headers.get('traceparent')).toMatch(/-00$/);

    const error = Response.error();
    expect(withTraceparent(error, ID)).toBe(error);
    expect(error.status).toBe(0);
  });

  it('recusa traceparent com maiúsculas e gera outro trace', async () => {
    const url = await serve(() => new Response('ok'));
    const response = await fetch(url, {
      headers: { traceparent: `00-${ID.toUpperCase()}-00f067aa0ba902b7-01` },
    });
    const header = response.headers.get('traceparent') ?? '';
    expect(header).toMatch(/^00-[0-9a-f]{32}-/);
    expect(header).not.toContain(ID);
  });

  it('repete as flags da entrada', async () => {
    const url = await serve(() => new Response('ok'));
    const response = await fetch(url, {
      headers: { traceparent: `00-${ID}-00f067aa0ba902b7-00` },
    });
    const header = response.headers.get('traceparent') ?? '';
    expect(header.startsWith(`00-${ID}-`)).toBe(true);
    expect(header.endsWith('-00')).toBe(true);
  });
});
