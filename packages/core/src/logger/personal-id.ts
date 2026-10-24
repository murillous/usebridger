// Reconhecedor de id pessoal por formato (ADR 0119): JID/handle com `@`, telefone e id numérico
// longo. O core não sabe o formato de id de cada transport, então a regra é só de formato.
// shortcut: heurística, um id opaco fora desses formatos passa, e um número longo legítimo
// (ex.: epoch em ms dentro de texto) é trocado a mais; quem precisa de exatidão usa `pseudonym`.

const CENSOR = '[REDACTED]';

const PERSONAL_ID_RE = /@|^\+?\d{7,}$|^-\d{5,}$/;

// `5565999998888:12@s.whatsapp.net`, `123@lid`, `1203-45@g.us`: o sufixo é o que decide.
const JID_RE = /[\w.:+-]+@(?:s\.whatsapp\.net|c\.us|g\.us|lid|broadcast|newsletter)/g;
// Telefone em texto livre: 10 a 15 dígitos, com `+` opcional. O lookbehind deixa de fora número
// JSON (`"ms":1730000000000`, que vem depois de `:` ou `,`) e dígitos dentro de palavra/id.
const PHONE_RE = /(?<![\w.:,[])\+?\d{10,15}(?!\w|\.\d)/g;

/** `true` se `value` inteiro parece id de chat/usuário (JID, telefone ou id numérico longo). */
export function isPersonalId(value: string): boolean {
  return PERSONAL_ID_RE.test(value);
}

/** Troca por `[REDACTED]` os JIDs e telefones que aparecem dentro de `text`. */
export function redactPersonalIds(text: string): string {
  const jids = text.includes('@') ? text.replace(JID_RE, CENSOR) : text;
  return jids.replace(PHONE_RE, CENSOR);
}
