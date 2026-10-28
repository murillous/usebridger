# @usebridger/transport-telegram

Esta página mostra como ligar o bot ao Telegram. O transport usa a Bot API pelo
[grammY](https://grammy.dev). Recebe por long polling (o bot pergunta ao Telegram pelas mensagens
novas), então não precisa de URL pública nem de `http` no `createBot`.

## Criar o bot no BotFather

1. No Telegram, abra o [@BotFather](https://t.me/BotFather) e envie `/newbot`.
2. Escolha um nome de exibição e um usuário (tem de terminar em `bot`, como `meu_bridger_bot`).
3. O BotFather responde com o **token**, no formato `123456789:ABC-DEF...`. Ele é a senha do bot:
   não o coloque no git. Guarde numa variável de ambiente (`TELEGRAM_TOKEN`).
4. Se o token vazar, use `/revoke` no BotFather para gerar outro.
5. Para o bot ler toda mensagem de um grupo, veja [Privacy mode](#privacy-mode).

## Uso

```ts
import { createBot } from '@usebridger/core';
import { telegram } from '@usebridger/transport-telegram';

const bot = createBot({
  transport: telegram({ token: process.env.TELEGRAM_TOKEN ?? '' }), // do @BotFather
  prefix: '/',
  owners: [{ id: '123456789' }], // o user ID do Telegram, não o @usuario
  plugins: [/* ... */],
});
await bot.start();
```

A única opção do transport é `token` (obrigatória). Ele é validado na fábrica: um formato
inválido vira `BotConfigError` no `createBot`, sem o token na mensagem. Não há pareamento nem
credencial no storage: tudo de que o bot precisa está no token.

## Conexão

O `connect()` chama o `getMe` (o resultado vira o `transport.self`, com `username` e
`isBot: true`), apaga um webhook que esteja ativo e começa o long polling. O grammY re-tenta
sozinho a queda de rede, o 5xx e o 429 do `getUpdates`, então o transport só emite `closed`
quando a queda é terminal:

| Causa | `reason` | O que o bot faz |
| --- | --- | --- |
| 401 (token revogado ou errado) | `auth-failed` | para, sem limpar nada (não há pareamento) |
| 409 (outro processo com o mesmo token) | `replaced` | para: duas instâncias se derrubariam em laço |
| Falha de rede no `getMe` do boot | `connection-lost` | reconecta pela política |

O `disconnect()` cancela o `getUpdates` em andamento e confirma o offset no Telegram: os updates
que chegaram e não foram tratados voltam na próxima subida.

## Privacy mode

Em grupo, o bot com privacy mode (o padrão do BotFather) só recebe comandos (`/cmd`), menções a
ele e respostas às mensagens dele. Um plugin que lê toda mensagem do grupo (gatilho por palavra,
contador) precisa de uma destas:

- desligar o privacy mode no BotFather (`/setprivacy` → `Disable`) e tirar e pôr o bot de novo no
  grupo;
- tornar o bot admin do grupo.

O comando chega como texto comum. O `/cmd@NomeDoBot` funciona sem configuração: o roteador tira o
`@` do `self.username`.

## O que o transport declara

`send.text`, `send.image`, `send.video`, `send.audio`, `send.voice`, `send.sticker`,
`send.document`, `media.download`, `media.ref`, `quoted`, `mentions`, `reactions`,
`message.edit`, `message.delete`, `typing`, `actions`, `groups`, `groups.remove` e
`groups.promote`. O álbum e as enquetes ainda não estão; bot do Telegram não
adiciona ninguém a grupo, então `groups.add` nunca vai estar.

Limites: 4096 caracteres de texto e 1024 de legenda (a fila de saída divide acima deles). Ritmo
padrão da fila: 34 ms entre envios quaisquer (30 por segundo) e 1 s por chat. O limite de 20
mensagens por minuto num grupo chega como 429 com `retry_after`, que a fila respeita.

## Entrada

| Telegram | Bridger |
| --- | --- |
| `photo` (a maior resolução) | `image`, `image/jpeg` |
| `video`, `animation` (GIF), `video_note` | `video` |
| `audio` / `voice` | `audio` / `voice` |
| `sticker` | `sticker`: `image/webp`, `video/webm` (vídeo) ou `application/x-tgsticker` (animado) |
| `document` | `document`, com `fileName` |
| `location` / `venue` | `location`; o `venue` traz `name` e `address` |
| `contact` | `contact`, com o vCard (montado do telefone se o Telegram não mandar) |
| `poll` | `poll` |
| `dice`, `game`, `story`, `invoice`... | `unknown`, com o update no `ctx.unsafe.raw()` |
| Mensagem de serviço (entrou, saiu, fixou) | nada; o título novo vira `group.updated` |
| `edited_message` | `message.edited` |
| `callback_query` | clique num botão (`interaction`) |
| `message_reaction` | `reaction` (só reação de emoji; a personalizada não vira evento) |
| `my_chat_member` | `group.joined` / `group.left` |
| `chat_member` | `group.participants` (`add`, `remove`, `promote`, `demote`, com o autor) |

- **IDs:** o `id` do contato é o user ID do Telegram, e o do chat, o chat ID (negativo em grupo).
  O `phone` é sempre `null`. Para `owners`, use `{ id: '<user ID>' }`.
- **Tópico de fórum:** a mensagem de um tópico tem `chat.id` `'<chat>/<tópico>'`, `kind: 'thread'`
  e `parentId` com o supergrupo. A resposta cai no mesmo tópico. A reação não diz o tópico e vem
  com o `chat.id` do supergrupo.
- **Admin anônimo e post de canal:** quem fala é o chat (`sender_chat`), com o `id` e o nome dele.
  O `isChatAdmin` reconhece o admin anônimo, que fala como o próprio grupo.
- **Menções:** a `text_mention` traz o contato com o ID. A `@usuario` só traz o texto, e a Bot
  API não resolve o ID: só a menção ao próprio bot entra em `message.mentions`.
- **Mídia:** baixa pelo `getFile` e pela URL de arquivos da Bot API, que não entrega arquivo
  acima de 20 MB. O `ctx.media.ref()` guarda o `file_id`, que vale entre restarts para o mesmo
  bot. Um `file_id` que o Telegram não reconhece rejeita com `MediaExpiredError`.
- **Apagadas:** a Bot API não avisa quando uma mensagem é apagada. O `message.deleted` nunca sai.
- **Reações e participantes** só chegam com o bot admin do grupo. Isso vale para o
  `message_reaction` e o `chat_member`.

## Envio

- **Texto cru vai sem `parse_mode`:** `<`, `*` e `_` saem literais. Para formatar, use a árvore
  neutra (`fmt`, `bold`, `mention`...), que o transport renderiza em HTML com escape. A menção da
  árvore vira um link `tg://user?id=`, que notifica pelo ID. O `mentions` das opções com texto cru
  não tem onde marcar e não notifica.
- **Citação:** `reply_parameters` com `allow_sending_without_reply`. Se a citada foi apagada, a
  resposta sai sem citação. A resposta a um clique é mensagem nova, sem citar.
- **Botões:** teclado inline, um botão por linha. O clique é confirmado na hora
  (`answerCallbackQuery`) e chega ao plugin como o comando do botão.
- **Mídia por URL:** vai para o Telegram baixar, que aceita até 5 MB de foto e 20 MB dos outros
  tipos. O documento com `fileName` é baixado pelo grammY e sobe com o nome.
- **Reação:** o Telegram aceita um conjunto fixo de emojis. Fora dele, a API devolve 400, e o
  erro chega com `retryable: false`.
- **Erros:** o 429 leva `retryAfterMs` (o `retry_after` × 1000), e os outros 4xx levam
  `retryable: false`. Queda de rede e 5xx seguem sem campo, e a fila re-tenta com backoff
  ([Erros de envio](../../core/docs/transport.md#erros-de-envio)).

## Grupos

- `getGroupMetadata` traz título, descrição e o dono (dos admins). Não traz `participants`: o
  Telegram não lista membros.
- `isChatAdmin` pergunta ao `getChatMember`, então o papel `group-admin` funciona.
- `remove` bane e desbane em seguida: a pessoa sai e pode voltar. `promote` dá os direitos de
  moderação comuns (gerenciar, apagar, restringir, convidar e fixar). `demote` tira todos. O bot
  precisa ser admin com o direito de promover.

## Menu de comandos

No `open` e a cada mudança da lista, o transport registra o menu com o `setMyCommands`, só se ele
mudou:

- os comandos `everyone` vão no escopo padrão;
- os `group-admin` vão, junto com os `everyone`, no escopo dos admins de grupo;
- `owner` e papéis custom ficam fora do menu, mas funcionam digitados.

Só o `name` aparece, com a `description` (ou o próprio nome, se não houver). O nome fora de
`[a-z0-9_]{1,32}` fica fora do menu, com log `telegram.commands.skipped` em `debug`.

## Escape hatch

- `ctx.unsafe.native` é o `Bot` do grammY da conexão atual (`bot.api` para o resto da Bot API).
- `ctx.unsafe.raw()` devolve o `Update` de onde a mensagem ou o clique saiu. Na citada, devolve a
  `Message` da Bot API.

## Logs

Os eventos de log do pacote estão no
[catálogo do core](../../core/docs/log-events.md#usebridgertransport-telegram).

## Problemas comuns

- **`BotConfigError` ao subir:** o token está vazio ou fora do formato `123456:ABC-DEF`. Confira
  se a variável de ambiente existe.
- **O bot para com `auth-failed`:** o BotFather revogou o token ou ele está errado.
- **O bot para com `replaced`:** outro processo usa o mesmo token. Só uma instância pode fazer
  long polling por bot.
- **No grupo, o bot só responde a comandos:** é o [privacy mode](#privacy-mode).
- **Sem reações nem entrada/saída de membros:** esses eventos só chegam com o bot admin do grupo.
- **Arquivo grande não baixa:** a Bot API não entrega arquivo acima de 20 MB.
