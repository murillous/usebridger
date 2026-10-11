import { describe, expect, it } from 'vitest';
import { fillMessage, formatMessage, placeholders } from './messages.ts';

describe('placeholders', () => {
  it('lista os nomes na ordem, sem repetir, e ignora chaves que não são identificador', () => {
    expect(placeholders('{prefix}merge: {count} de {total} ({count}) { ok } {1x} {a-b}')).toEqual([
      'prefix',
      'count',
      'total',
    ]);
    expect(placeholders('sem nada')).toEqual([]);
  });
});

describe('fillMessage', () => {
  it('troca cada placeholder pelo valor, número inclusive', () => {
    expect(fillMessage('📎 PDF adicionado ({count}). { ok }', { count: 2 }, 'added')).toBe(
      '📎 PDF adicionado (2). { ok }',
    );
  });

  it('placeholder sem valor lança TypeError com a chave e o nome', () => {
    expect(() => fillMessage('{count} de {total}', { count: 1 }, 'added')).toThrow(
      'mensagem "added": falta o valor do placeholder {total}',
    );
  });
});

describe('formatMessage', () => {
  const messages = { uso: 'Use {prefix}sticker respondendo uma imagem' };

  it('preenche o {prefix} com o do chat, por cima de um valor do plugin', () => {
    expect(formatMessage(messages, 'uso', { prefix: 'x' }, '/')).toBe(
      'Use /sticker respondendo uma imagem',
    );
  });

  it('chave que o plugin não declara lança TypeError', () => {
    expect(() => formatMessage(messages, 'usso', undefined, '!')).toThrow(
      'mensagem "usso" não declarada em messages',
    );
    expect(() => formatMessage(messages, 'toString', undefined, '!')).toThrow(TypeError);
  });
});
