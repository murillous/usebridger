# ADR 0109 — Complementos ao contrato das abas do dashboard

**Status:** Substituído por [ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)
(2026-10-25) · Aceito (2026-10-17) · Complementa **D104** ([ADR 0104](0104-abas-do-dashboard-por-ponto-de-extensao.md))

## Contexto

A implementação do ADR 0104 (M5-4.6) precisou de detalhes que o contrato não fixava. Nenhum muda
a decisão; todos são aditivos ou tornam o contrato mais defensivo.

## Decisão

- **`series.title?`:** o widget `series` aceita um `title` opcional, usado como título do cartão e
  no rótulo acessível do gráfico (`role="img"`). Sem ele, o dashboard usa "Série". Campo opcional:
  acrescentá-lo é minor.
- **Manifesto mascarado:** o JSON Schema do `form` sai por `maskedJsonSchema` (core), o mesmo caminho
  da config de plugin: campo `secret()` leva `secret: true` e o `default` vira a máscara. O valor real
  nunca vai ao browser.
- **Secret em form de aba é entrada:** diferente da Config (secret só leitura, o valor vem do
  arquivo ou do env), no form de aba o campo `secret` é um `<input type="password">` vazio, enviado
  no corpo do `submit`. É dado digitado agora, não config persistida.
- **Widget que não vira manifesto:** se montar o manifesto de um widget lançar (ex.: `toJSONSchema`),
  só esse widget sai, com `warn` uma vez; a aba e as demais seguem.
- **Forma do `load` e `order`:** itens fora do contrato (`stats` sem `label` string ou `value`
  string/número finito; linha sem `id` string; ponto sem `label` string ou `value` número finito)
  são descartados com `warn`, antes do corte de tamanho (500 linhas, 1000 pontos, 50 `stats`).
  `order` que não é número finito vale 0.
- **`text`:** `markdown` é exibido hoje como texto puro; renderizar Markdown fica para quando um
  caso pedir, sem mudar o contrato.

## Consequências

- O core ganha `maskedJsonSchema(schema)` público (aditivo, minor).
- Quem contribui não precisa se proteger de um item ruim derrubar a tela, mas ainda deve devolver o
  formato do contrato: o que sai dele some.
