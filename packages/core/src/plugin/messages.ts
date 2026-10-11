// Placeholders nas `messages` do plugin (ADR 0092): `{nome}` no texto, preenchido na hora de usar
// por `ctx.t`. O `{prefix}` o kernel resolve para o chat da mensagem; os outros o plugin passa.

/** Valores dos placeholders de uma mensagem. */
export type MessageValues = Readonly<Record<string, string | number>>;

/**
 * Texto de `messages` com os placeholders preenchidos. O `{prefix}` vem do chat da mensagem; os
 * demais, de `values`. Chave que o plugin não declara, ou placeholder sem valor, lança
 * `TypeError`: é erro do plugin, e a config só sobrescreve com os placeholders do texto padrão.
 */
export type MessageText = (key: string, values?: MessageValues) => string;

/** Placeholder que o kernel preenche: o prefixo de comando do chat (ADR 0063). */
export const PREFIX_PLACEHOLDER = 'prefix';

// Só `{identificador}`: chaves com espaço ou pontuação (`{ ok }`, JSON) ficam como texto.
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Nomes dos placeholders do texto, na ordem em que aparecem, sem repetição. */
export function placeholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] as string))];
}

/** Preenche os placeholders de `text`; `key` só entra na mensagem de erro. */
export function fillMessage(text: string, values: MessageValues, key: string): string {
  return text.replaceAll(PLACEHOLDER, (_match, name: string) => {
    // `hasOwn`: um `{constructor}` sem valor não pode cair no método herdado do `Object`.
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      throw new TypeError(`mensagem "${key}": falta o valor do placeholder {${name}}`);
    }
    return String(value);
  });
}

/** O `ctx.t`: a mensagem `key` das `messages` do plugin, com o `{prefix}` do chat. */
export function formatMessage(
  messages: Readonly<Record<string, string>>,
  key: string,
  values: MessageValues | undefined,
  prefix: string,
): string {
  if (!Object.hasOwn(messages, key)) {
    throw new TypeError(`mensagem "${key}" não declarada em messages`);
  }
  return fillMessage(messages[key] as string, { ...values, [PREFIX_PLACEHOLDER]: prefix }, key);
}
