# ADR 0100 — Menção com `tag` no texto e `textWithMentionNames`

**Status:** Aceito (2026-10-15) · Detalha [ADR 0057](0057-contact-multiplataforma.md) e
[ADR 0061](0061-texto-formatado-neutro.md)

## Contexto

No WhatsApp, "luma fale bem de @murilo" chega com `message.text = "luma fale bem de @859302458"`:
o texto traz o token do JID, não o nome (#109). Um plugin de IA que passa o texto ao prompt manda
um número sem sentido. O `Contact.id` é opaco para o core ([ADR 0046](0046-ids-de-contato-e-metadata-de-grupo.md)),
então ele não sabe qual trecho do texto corresponde a qual menção.

## Decisão

- `Mention extends Contact` com `tag?: string`: o trecho literal da menção em `text`. É opcional,
  então transport que não precisa dele (Discord já troca por `@nome`) segue válido, e `Contact`
  continua atribuível a `Mention`. `Message.mentions` passa a ser `readonly Mention[]`.
- O core exporta `textWithMentionNames({ text, mentions })`: troca cada `tag` por `@${name}`.
  Menção sem `tag` ou sem `name` deixa o texto como está. A troca é numa passada, com os tags do
  maior para o menor e sem casar tag seguido de letra ou dígito, para `@123` não corromper `@1234`.
  O nome entra de forma literal.
- O `name` vem do cache de contatos do transport. No WhatsApp não há consulta de pushName: contato
  nunca visto fica sem nome, e o tag permanece no texto.

## Alternativa descartada

O core derivar o token a partir do `id` (por exemplo, a parte numérica do JID). Obriga o core a
interpretar um ID que é opaco, e vale só para um transport.

## Consequências

- Mudança aditiva, sem quebrar transports nem plugins.
- Contato nunca visto continua aparecendo como número até o transport conhecê-lo.
- Follow-up: persistir o cache de contatos do transport, para o nome sobreviver a reinício.
