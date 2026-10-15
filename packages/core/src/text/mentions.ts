import type { Message } from '#message/types.ts';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Devolve `message.text` com o trecho de cada menção (`tag`) trocado por `@nome`.
 *
 * O `id` do contato é opaco para o core, então só o transport sabe qual token ele pôs no texto;
 * por isso a troca parte do `tag` que ele informou. Menção sem `tag` ou sem `name` fica como está.
 */
export function textWithMentionNames(message: Pick<Message, 'text' | 'mentions'>): string | null {
  const { text, mentions } = message;
  if (text === null) return null;

  const names = new Map<string, string>();
  for (const m of mentions) {
    // A primeira menção de um mesmo tag vence; duplicadas não mudam o resultado.
    if (m.tag && m.name && !names.has(m.tag)) names.set(m.tag, m.name);
  }
  if (names.size === 0) return text;

  // Uma passada só, do tag maior para o menor: `@1234` não é corrompido por `@123`, e o nome
  // inserido nunca é reprocessado. O lookahead evita casar `@123` dentro de `@1234` sem menção.
  const tags = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?:${tags.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  // Callback em vez de string: `$&` e afins no nome ficam literais.
  return text.replace(pattern, (tag) => `@${names.get(tag)}`);
}
