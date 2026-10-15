import { describe, expect, it } from 'vitest';
import type { Mention } from '#message/types.ts';
import { textWithMentionNames } from './mentions.ts';

const m = (tag: string | undefined, name: string | null): Mention => ({
  id: `id-${tag ?? 'x'}`,
  name,
  phone: null,
  ...(tag === undefined ? {} : { tag }),
});

describe('textWithMentionNames', () => {
  it('troca o tag pelo nome', () => {
    expect(
      textWithMentionNames({
        text: 'luma fale bem de @859302458',
        mentions: [m('@859302458', 'Murilo')],
      }),
    ).toBe('luma fale bem de @Murilo');
  });

  it('mantém o tag quando a menção não tem nome', () => {
    expect(textWithMentionNames({ text: 'oi @111', mentions: [m('@111', null)] })).toBe('oi @111');
    expect(textWithMentionNames({ text: 'oi @111', mentions: [m('@111', '')] })).toBe('oi @111');
  });

  it('ignora a menção sem tag', () => {
    expect(textWithMentionNames({ text: 'oi @111', mentions: [m(undefined, 'Ana')] })).toBe(
      'oi @111',
    );
  });

  it('devolve null para texto null', () => {
    expect(textWithMentionNames({ text: null, mentions: [m('@1', 'Ana')] })).toBeNull();
  });

  it('não corrompe o tag maior quando o menor é prefixo dele', () => {
    const mentions = [m('@123', 'Ana'), m('@1234', 'Bia')];
    expect(textWithMentionNames({ text: '@1234 e @123', mentions })).toBe('@Bia e @Ana');
  });

  it('não troca tag que só é prefixo de um token sem menção', () => {
    expect(textWithMentionNames({ text: '@1234', mentions: [m('@123', 'Ana')] })).toBe('@1234');
  });

  it('troca todas as ocorrências', () => {
    expect(textWithMentionNames({ text: '@1 e @1, @1!', mentions: [m('@1', 'Ana')] })).toBe(
      '@Ana e @Ana, @Ana!',
    );
  });

  it('aceita menções duplicadas', () => {
    const mentions = [m('@1', 'Ana'), m('@1', 'Ana')];
    expect(textWithMentionNames({ text: '@1', mentions })).toBe('@Ana');
  });

  it('usa o nome de forma literal, sem interpretar padrões de replace', () => {
    expect(
      textWithMentionNames({ text: 'oi @1 @2', mentions: [m('@1', '$&'), m('@2', '.*')] }),
    ).toBe('oi @$& @.*');
  });

  it('escapa o tag ao montar a regex', () => {
    expect(textWithMentionNames({ text: 'a.b a-b', mentions: [m('a.b', 'X')] })).toBe(
      'X a-b'.replace('X', '@X'),
    );
  });
});
