import { describe, expect, it } from 'vitest';
import { UnsupportedError } from '#transport/capabilities.ts';
import { OutboundQueueError } from './errors.ts';
import { backoffDelay, isTransient, type RetryPolicy, retryAfter, retryDelay } from './retry.ts';

const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  isRetryable: isTransient,
};
const full = (): number => 1;

describe('retryAfter', () => {
  it('lê a janela e o escopo do erro', () => {
    expect(retryAfter({ retryAfterMs: 500 })).toEqual({ ms: 500, global: false });
    expect(retryAfter({ retryAfterMs: 0, retryAfterScope: 'global' })).toEqual({
      ms: 0,
      global: true,
    });
  });

  it('ignora janela ausente, negativa, infinita ou que não é número', () => {
    for (const error of [
      new Error('x'),
      null,
      'texto',
      { retryAfterMs: -1 },
      { retryAfterMs: Number.POSITIVE_INFINITY },
      { retryAfterMs: Number.NaN },
      { retryAfterMs: '500' },
    ]) {
      expect(retryAfter(error)).toBeUndefined();
    }
  });
});

describe('isTransient', () => {
  it('é falso para UnsupportedError e retryable: false', () => {
    expect(isTransient(new UnsupportedError('send.voice', 'fake'))).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { retryable: false }))).toBe(false);
  });

  it('é verdadeiro para o resto', () => {
    expect(isTransient(new Error('x'))).toBe(true);
    expect(isTransient({ retryable: true })).toBe(true);
    expect(isTransient('texto')).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('dobra a cada falha até o teto', () => {
    const delays = [1, 2, 3, 6, 7].map((failures) => backoffDelay(failures, policy, full));
    expect(delays).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });

  it('aplica jitter "igual": metade fixa, metade aleatória', () => {
    expect(backoffDelay(2, policy, () => 0)).toBe(1000);
    expect(backoffDelay(2, policy, () => 0.5)).toBe(1500);
  });
});

describe('retryDelay', () => {
  it('re-tenta falha transitória com o backoff', () => {
    expect(retryDelay(new Error('x'), 1, undefined, policy, full)).toBe(1000);
    expect(retryDelay(new Error('x'), 2, undefined, policy, full)).toBe(2000);
  });

  it('não re-tenta depois de esgotar as tentativas', () => {
    expect(retryDelay(new Error('x'), 3, undefined, policy, full)).toBeNull();
  });

  it('não re-tenta UnsupportedError nem retryable: false', () => {
    expect(
      retryDelay(new UnsupportedError('send.voice', 'fake'), 1, undefined, policy, full),
    ).toBeNull();
    const permanent = Object.assign(new Error('x'), { retryable: false });
    expect(retryDelay(permanent, 1, undefined, policy, full)).toBeNull();
  });

  it('não re-tenta prazo estourado nem outro OutboundQueueError', () => {
    const timeout = new OutboundQueueError('timeout', 'sem resposta');
    expect(retryDelay(timeout, 1, undefined, policy, full)).toBeNull();
  });

  it('usa a janela informada no lugar do backoff, sem jitter, inclusive a global', () => {
    const error = new Error('429');
    expect(retryDelay(error, 1, { ms: 5000, global: false }, policy, () => 0)).toBe(5000);
    expect(retryDelay(error, 1, { ms: 0, global: true }, policy, () => 0)).toBe(0);
  });

  it('não re-tenta com a janela acima de maxDelayMs', () => {
    const hint = { ms: 30_001, global: true };
    expect(retryDelay(new Error('429'), 1, hint, policy, full)).toBeNull();
  });

  it('a janela não salva o que isRetryable diz ser permanente', () => {
    const permanent = Object.assign(new Error('x'), { retryable: false });
    expect(retryDelay(permanent, 1, { ms: 10, global: false }, policy, full)).toBeNull();
  });

  it('usa o isRetryable da política e deixa o erro dele subir', () => {
    const never = { ...policy, isRetryable: () => false };
    expect(retryDelay(new Error('x'), 1, undefined, never, full)).toBeNull();
    const broken = {
      ...policy,
      isRetryable: () => {
        throw new Error('hook');
      },
    };
    expect(() => retryDelay(new Error('x'), 1, undefined, broken, full)).toThrow('hook');
  });
});
