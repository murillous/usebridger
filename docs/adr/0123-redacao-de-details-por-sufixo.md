# ADR 0123 — Redação dos `details` da auditoria por sufixo

**Status:** Aceito (2026-10-25) · Amplia o item 2 da redação de `details` do **D122**
([ADR 0122](0122-log-de-auditoria-no-kernel.md))

## Contexto

O ADR 0122 mascara nos `details` do `ctx.audit` uma lista exata de chaves (`password`, `token`,
`apiKey`...). Chaves derivadas passam em claro: `accessToken`, `refreshToken`, `clientSecret`,
`dbPassword`. Um segredo que não está entre os segredos do bot e chega com uma dessas chaves fica
gravado na cadeia, que é imutável por desenho (#268).

## Decisão

- A chave é normalizada: minúsculas, sem `_` nem `-`. `API_KEY`, `api-key` e `apiKey` viram
  `apikey`.
- É segredo se terminar em `password`, `passwd`, `token`, `secret` ou `apikey`, ou se for
  exatamente `authorization` ou `cookie`.
- Só o sufixo conta. `tokenizer` e `secretary` ficam em claro.
- O logger não muda. O redator dele não tem lista de chaves: ele mascara os valores dos segredos
  e os `paths` que o app passa em `redact` (pino). Não há critério de chave para divergir.

## Consequências

- Mascarar a mais é aceitável. Uma chave como `nextPageToken` some do evento, e o fato auditado
  continua registrado. Gravar um segredo para sempre não tem conserto.
- `cookie` e `authorization` seguem exatos, porque um sufixo `cookie` pegaria chaves como
  `acceptedCookie` sem ganho real.
- Eventos gravados antes não mudam: a cadeia não é reescrita.
