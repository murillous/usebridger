# ADR 0141 — Figurinha com áudio: campos no `sticker` e capability `send.sticker.audio`

**Status:** Aceito (2026-11-24) · PR #350 · Estende o [ADR 0008](0008-capabilities-do-transporte.md)
(capabilities)

## Contexto

O WhatsApp tem figurinha com som: um `StickerMessage` com um `AudioMessage` no campo 26. O
PR #350 pôs `audio`, `audioMimetype` e `audioSeconds` no `OutgoingContent` de `type: 'sticker'` e
no `reply.sticker`, e o Baileys passou a enviá-la. Nenhum outro transport conhece o recurso.

Sem capability, o Telegram e o web recebiam a figurinha com `audio` e enviavam só a imagem. O
plugin não tinha como saber que o som se perdeu, nem como declarar que depende dele.

## Opções consideradas

1. **Capability `send.sticker.audio`, exigida quando o `sticker` traz `audio` — recomendada.** O
   `capabilitiesForSend` a acrescenta, a fila recusa com `UnsupportedError` no transport que não
   a declara, e o plugin pode pô-la em `requires` ou conferir em `ctx.capabilities`.
2. Tipo novo `sound-sticker` no `OutgoingContent`. Descartada: é a mesma figurinha com um anexo;
   um tipo novo obriga cada `switch` de transport a tratá-lo, e o `reply.sticker` teria dois
   caminhos.
3. Degradar em silêncio (enviar só a figurinha). Descartada: o erro some sem destino, e o
   plugin que só faz sentido com som não consegue recusar a carga no boot.

## Decisão

`send.sticker.audio` entra em `CAPABILITIES`. `capabilitiesForSend` a exige, além de
`send.sticker`, quando `content.audio` está presente. O Baileys a declara; o Telegram e o web não.
O transport sem ela nunca recebe uma figurinha com `audio`, então não precisa olhar o campo.

No Baileys, o `sendMessage` não monta esse conteúdo: o transport sobe as duas mídias, monta o
`StickerMessage` com o campo 26 e envia pelo `relayMessage`. O `WAProto` do Baileys 7.0.0-rc14
não declara o campo, então o transport estende o `encode`/`fromObject` do `StickerMessage` em
runtime. Menções e citação vão no `contextInfo`, como no `sendMessage`.

## Consequências

- O plugin que quer som declara `send.sticker.audio` em `requires`, ou confere a capability e
  envia a figurinha muda como alternativa.
- O caminho pelo `relayMessage` pula o que o `sendMessage` faz além de montar e enviar: não emite
  a mensagem própria no `messages.upsert` e não aplica a expiração de mensagens temporárias.
- O patch do `WAProto` depende do formato interno do Baileys. Quando o Baileys declarar o campo
  26, o patch sai.
