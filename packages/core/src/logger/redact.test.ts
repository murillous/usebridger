import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.ts';
import { createSecretSet } from './secrets.ts';

const SECRET = 'sk-supersecret-123456';

function redactor() {
  const secrets = createSecretSet();
  secrets.set('test', [SECRET]);
  return createRedactor(secrets);
}

describe('createRedactor', () => {
  it('Error: mantém a classe e censura message e stack', () => {
    class MyError extends Error {}
    const copy = redactor()(new MyError(`falhou ${SECRET}`));
    expect(copy).toBeInstanceOf(MyError);
    expect(copy.message).toBe('falhou [REDACTED]');
    expect(copy.stack).toContain('[REDACTED]');
    expect(copy.stack).not.toContain(SECRET);
  });

  it('Map e Set saem recriados e censurados', () => {
    const copy = redactor()({ map: new Map([['k', `v ${SECRET}`]]), set: new Set([SECRET]) });
    expect(copy.map.get('k')).toBe('v [REDACTED]');
    expect([...copy.set]).toEqual(['[REDACTED]']);
  });

  it('getter próprio e de classe com campo privado não vazam nem lançam', () => {
    class WithPrivate {
      #token = SECRET;
      readonly own = 1;
      get token(): string {
        return this.#token;
      }
    }
    const error = Object.defineProperty(new Error('x'), 'leak', {
      get: () => SECRET,
      enumerable: true,
    });
    const copy = redactor()({ error, klass: new WithPrivate() }) as unknown as {
      error: { leak: string };
      klass: { own: number };
    };
    expect(copy.error.leak).toBe('[REDACTED]');
    expect(copy.klass.own).toBe(1);
    expect(JSON.stringify(copy)).not.toContain(SECRET);
  });

  it('subclasse de Error com getter, toJSON e #privado não lança nem vaza', () => {
    class Leaky extends Error {
      #token = SECRET;
      get token(): string {
        return this.#token;
      }
      get closure(): string {
        return SECRET;
      }
      toJSON(): unknown {
        return { t: this.#token };
      }
    }
    const copy = redactor()(new Leaky('x'));
    expect(copy.token).toBe('[REDACTED]');
    expect(copy.closure).toBe('[REDACTED]');
    expect(JSON.stringify(copy)).toBe('{"t":"[REDACTED]"}');
  });

  it('Proxy ilegível vira [unreadable]', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(redactor()({ p: proxy })).toEqual({ p: '[unreadable]' });
  });

  it('caixa String vira o primitivo censurado', () => {
    const boxed = new String(SECRET);
    expect(redactor()({ b: boxed })).toEqual({ b: '[REDACTED]' });
  });

  it('instância de classe dentro de cause vira objeto simples censurado', () => {
    class Headers {
      Authorization = `Bearer ${SECRET}`;
    }
    const original = new Error('x', { cause: new Headers() });
    const copy = redactor()(original);
    const cause = copy.cause as Headers;
    expect(cause).not.toBe(original.cause);
    expect(cause).not.toBeInstanceOf(Headers);
    expect(cause.Authorization).toBe('Bearer [REDACTED]');
  });
});
