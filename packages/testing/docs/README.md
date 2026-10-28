# @usebridger/testing — documentação

Kit para testar plugins sem rede. Ele sobe um `Bot` de verdade (plugins, filas, middlewares,
roteador) sobre o `FakeTransport`, que guarda o que o bot envia.

## Instalação

```sh
pnpm add -D @usebridger/testing vitest
```

O kit funciona só com o Vitest (`vitest` é peer dependency). Importar o pacote registra os
matchers. Não é preciso configurar nada no `vitest.config`.

## Primeiro teste

```ts
import { createTestBot, fixtures } from '@usebridger/testing';
import { afterEach, expect, it } from 'vitest';
import { sticker } from './index.ts';

it('imagem com !s vira figurinha', async () => {
  const bot = await createTestBot({ plugins: [sticker()] });

  await bot.receive({ text: '!s', image: fixtures.image() });

  expect(bot.sent).toContainSticker();
  await bot.stop();
});
```

O `receive()` resolve depois que o bot terminou de processar a mensagem (`bot.settled()`). Nesse
momento, o que ela causou já está em `bot.sent`, inclusive os envios feitos sem `await`. Por isso
o teste não precisa de `sleep`.

Chame `bot.stop()` no fim de cada teste, ou guarde os bots e pare todos no `afterEach`. O
`stop()` roda o `teardown` dos plugins e fecha o storage.

## `createTestBot(options)`

Recebe a mesma config do `createBot`, menos o `transport`, que é opcional, e devolve o bot já
iniciado. Os padrões mudam para o caso de teste:

| Opção | Padrão no kit | Por quê |
| --- | --- | --- |
| `transport` | `new FakeTransport()`, com todas as capabilities | |
| `profile` | nenhum | Atalho para `transport: new FakeTransport({ profile })` ([perfis](#perfis-de-plataforma)). Não combina com `transport` |
| `logger` | `silent` | Saída limpa. Com `logLevel`, o bot cria o logger dele |
| `env` | `{}` | Nenhum `BRIDGER_*` da máquina entra na config dos plugins |
| `outbound` | `globalIntervalMs` e `chatIntervalMs` em 0 | Os envios saem na hora |
| `reconnection` | `false` | |
| `storage` | em memória | O kit o cria e o fecha no `stop()`; o `restart()` o mantém |

Qualquer opção pode ser sobrescrita, por exemplo `pluginConfig`, `owners`, `prefix` ou `storage`.

### `TestBot`

| Membro | O que faz |
| --- | --- |
| `receive(input)` | Entrega uma mensagem, espera o bot assentar e devolve a `Message` entregue |
| `click(sent, label, options?)` | Clica no botão de rótulo `label` de um envio e espera o bot assentar ([botões](#botões)) |
| `emit(event, payload)` | Simula outro evento do transport (`reaction`, `group.joined`...) e espera o bot assentar |
| `sent` | Os envios, na ordem (`SentMessage[]`) |
| `sentMedia(type)` | Os envios de mídia do tipo, na ordem, com os bytes ([abaixo](#bytes-enviados-sentmedia)) |
| `transport` | O `FakeTransport`, com os outros registros |
| `bot` | O `Bot` (`plugins()`, `plugins.reload`/`disable`/`enable`, `stats()`, `config`...) |
| `restart(overrides?)` | Para o bot e sobe outro sobre o mesmo storage; devolve o `TestBot` novo ([abaixo](#restart)) |
| `stop()` | Para o bot |

### Restart

O `restart()` simula um deploy ou um crash: para o bot e sobe outro com as mesmas opções sobre o
**mesmo storage**, que não fecha no meio. Serve para testar o que sobrevive ao restart, como as
[esperas persistidas](../../core/docs/conversations.md#conversa-que-sobrevive-a-restart):

```ts
const antes = await createTestBot({ plugins: [pedidos()] });
await antes.receive({ text: '!pedido' });

const depois = await antes.restart();
await depois.receive({ text: 'Rua A, 10' });
expect(depois.sent).toContainText('Confirma o pedido?');
await depois.stop();
```

- `overrides` troca opções do bot novo, como a versão nova do plugin
  (`antes.restart({ plugins: [pedidosV2()] })`). O `storage` não se troca.
- O transport criado pelo kit é novo, e `sent` do bot novo começa vazio. Um `transport` passado
  nas opções é reaproveitado (e o `sent` dele continua).
- Use o `TestBot` devolvido daí em diante. O storage fecha no `stop()` do último bot; o `stop()`
  do anterior só confirma que ele parou.

A mídia do `receive()` tem referência (capability `media.ref`): a do `FakeTransport` são
os próprios bytes, então o `ctx.media.fromRef` do bot novo baixa o que o antigo guardou.

## Mensagem de entrada

O `receive()` recebe só o que importa para o teste. O resto vem preenchido com padrões:

```ts
await bot.receive({ text: 'oi' });                               // texto
await bot.receive({ text: 'legenda', image: buffer });           // imagem com legenda
await bot.receive({ voice: { data: buffer, mimetype: 'audio/ogg' } });
await bot.receive({ document: buffer, fileName: 'a.pdf' });
await bot.receive({ text: '!s', quoted: { image: buffer } });    // respondendo uma imagem
await bot.receive({ text: 'oi', chat: { id: 'grupo@fake', isGroup: true } });
await bot.receive({ text: '!config', sender: { phone: '5511999999999' } });
```

| Campo | Padrão |
| --- | --- |
| `chat` | `DEFAULT_CHAT` (`chat@fake`, conversa privada). Uma string vira conversa privada com esse ID |
| `sender` | O remetente do perfil ou, sem perfil, `DEFAULT_SENDER` (`user@fake`, telefone `5511900000000`). Os campos informados substituem os do padrão |
| `id` | `in-1`, `in-2`... Cada `TestBot` tem a própria contagem |
| `timestamp` | `Date.now()` |
| `fromMe`, `isForwarded`, `isViewOnce` | `false` |

As mídias aceitas são `image`, `video`, `audio`, `voice`, `sticker` e `document`, no máximo uma
por mensagem. Quando a mídia vem só como `Buffer`, o mimetype é o que o WhatsApp usa para o tipo:
`image/jpeg`, `video/mp4`, `audio/mpeg`, `audio/ogg; codecs=opus`, `image/webp` e
`application/octet-stream`. O `quoted` aceita uma descrição como esta ou uma `Message` pronta.

Os outros arquivos da mesma mensagem, como numa mensagem do Discord, vão em `attachments`, depois
da mídia principal, que dá o `type`. Sem mimetype, o anexo é `application/octet-stream`:

```ts
await bot.receive({
  image: buffer,
  attachments: [{ data: pdf, mimetype: 'application/pdf', fileName: 'nota.pdf' }],
});
```

### Objeto bruto (`ctx.unsafe.raw`)

Para testar um plugin específico de plataforma, que lê o objeto bruto com `ctx.unsafe.raw()`
([escape hatch](../../core/docs/unsafe.md)), passe um objeto falso em `raw`. Ele vale também na
citada descrita, e o `click()` aceita `raw` nas opções para a interação do clique. Sem `raw`, o
`ctx.unsafe.raw()` devolve `undefined`:

```ts
await bot.receive({ text: '!info', raw: { update_id: 1, message: { entities: [] } } });
await bot.click(bot.sent[0], 'Notas', { raw: { callback_query: { id: 'cq1' } } });
```

Para outra interação, como um comando nativo emitido com `bot.emit('interaction', ...)`, registre
o objeto com `bot.transport.setRaw(interaction, raw)` antes de emitir.

### Outras plataformas

O `Chat` e o `sender` completos simulam o que não existe no WhatsApp: thread, servidor, remetente
bot, claims e tenant.

```ts
// Thread do Discord, num servidor
await bot.receive({ text: '!s', chat: { id: 't1', isGroup: true, kind: 'thread', parentId: 'srv1' } });
// Outro bot no canal (o `ignoreBots` do core descarta por padrão)
await bot.receive({ text: '!ping', sender: { isBot: true } });
// Usuário do web, com os claims do JWT e o tenant verificado
await bot.receive({
  text: '!notas',
  chat: { id: 'escola-a:sala', isGroup: false, tenantId: 'escola-a' },
  sender: { id: 'escola-a:u1', phone: null, claims: { papel: 'professora' } },
});
```

## Perfis de plataforma

Sem perfil, o `FakeTransport` declara todas as capabilities, e o plugin nunca é testado num
transport sem grupo, sem citação ou sem figurinha. Com `profile`, o transport declara o que a
plataforma declararia:

```ts
const bot = await createTestBot({ profile: 'telegram', plugins: [meuPlugin()] });
```

| Perfil | Capabilities | Limites | Contatos |
| --- | --- | --- | --- |
| `whatsapp` | As do Baileys: todas, menos `actions` e `send.album` | Nenhum | Com telefone (`DEFAULT_SELF`, `DEFAULT_SENDER`) |
| `telegram` | Sem `groups.add`, `pairing` | Texto 4096, legenda 1024, álbum 10 | `username`, `phone: null`; o `self` tem `isBot` |
| `discord` | Sem `groups.add`, `groups.promote`, `send.voice`, `send.sticker`, `pairing` | Texto e legenda 2000, álbum 10, 25 botões | `username`, `phone: null`; o `self` tem `isBot` |
| `web` | As do `transport-web`: texto, imagem, vídeo, áudio, documento, download, `actions`, `quoted`, `typing`, edição e remoção | Nenhum | Só ID e nome |

A lista completa de cada um está em `PROFILES`. O `whatsapp` e o `web` são o que o Baileys e o
`transport-web` declaram, e um teste em cada transport garante isso. O `telegram` e o `discord`
são previsões e podem mudar numa minor do kit: o `telegram` ainda declara `send.album` e `polls`,
que o `@usebridger/transport-telegram` não tem.

O `receive()` e o `click()` usam o remetente do perfil, inclusive com o perfil passado no
`FakeTransport` à mão. As opções `capabilities`, `limits` e `self` do `FakeTransport` substituem o
campo do perfil. Para tirar uma capability do perfil:

```ts
const transport = new FakeTransport({
  profile: 'telegram',
  capabilities: PROFILES.telegram.capabilities.filter((c) => c !== 'polls'),
});
```

O plugin que exige no manifesto uma capability fora do perfil (`requires`) derruba o boot com
`PluginBootError`, como no transport real. Para degradar por perfil, ponha o `requires` no
comando: só ele fica de fora. Owner por telefone não casa com o remetente sem telefone; use `{ id }`.

### O mesmo teste em todos os perfis

```ts
import { createTestBot, PROFILE_NAMES } from '@usebridger/testing';

describe.each(PROFILE_NAMES)('no %s', (profile) => {
  it('responde ao !ping', async () => {
    const bot = await createTestBot({ profile, plugins: [ping()] });
    await bot.receive({ text: '!ping' });
    expect(bot.sent).toContainText('pong');
    await bot.stop();
  });
});
```

Prefira `toContainText` a `toHaveReplied` na matriz: num perfil sem `quoted` (todos os quatro têm
hoje), a resposta sai sem citar.

## Botões

O `FakeTransport` tem a capability `actions` por padrão, e o envio com botões traz `actions` no
`SentMessage`. O `click()` clica num deles pelo rótulo. Quem clica é o `DEFAULT_SENDER`, e o chat
é o da mensagem citada pelo envio; `options.sender` e `options.chat` mudam os dois:

```ts
await bot.receive({ text: '!menu' });
await bot.click(bot.sent[0], 'Notas', { sender: { id: 'outra@fake' } });
expect(bot.sent).toContainText('Notas de Ana');
```

Sem a capability, o menu sai em texto numerado, e o teste responde com o número:

```ts
const bot = await createTestBot({
  plugins: [escola],
  transport: new FakeTransport({ capabilities: ['send.text', 'quoted'] }),
});
await bot.receive({ text: '!menu' });
await bot.receive({ text: '1' });
```

## Espera que vence (`onExpire`)

O kit não tem relógio próprio: para vencer uma espera (`expectReply` com `ttlMs`) e testar o
`onExpire` do passo, use os fake timers do Vitest. Depois de avançar o tempo, espere o bot
assentar com `bot.bot.settled()`, porque o `onExpire` roda na fila do chat e nenhuma mensagem
nova o espera:

```ts
import { vi } from 'vitest';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('encerra quem não responde', async () => {
  const bot = await createTestBot({ plugins: [cadastro] });
  await bot.receive({ text: '!cadastro' });
  await vi.advanceTimersByTimeAsync(60_000);
  await bot.bot.settled();
  expect(bot.sent).toContainText('Encerrei por falta de resposta.');
  await bot.stop();
});
```

Ligue os fake timers antes do `createTestBot`: a espera arma o timer dela no relógio que estiver
valendo quando o `expectReply` roda.

## Série do scheduler (`every`)

Também sem API própria: ligue os fake timers antes do `createTestBot` e avance o relógio com
`vi.advanceTimersByTimeAsync`. Cada ocorrência chega ao handler com `scheduledAt` exato e o mesmo
`seriesId`; `cancel(id)` encerra a série. Para regra de calendário, fixe a data com
`vi.setSystemTime`. Exemplo em [`scheduler-every.test.ts`](../src/scheduler-every.test.ts).

## Fixtures

Um plugin que decodifica a mídia (sharp, ffmpeg) falha com bytes quaisquer, como
`Buffer.from('...')`. O `fixtures` tem uma mídia válida e pequena de cada tipo, pronta para o
`receive()`:

```ts
import { createTestBot, fixtures } from '@usebridger/testing';

await bot.receive({ text: '!s', image: fixtures.image() });
await bot.receive({ text: '!s', quoted: { video: fixtures.video() } });
await bot.receive({ document: fixtures.document(), fileName: 'a.pdf' });
```

| Fixture | Formato | Mimetype |
| --- | --- | --- |
| `image()` | JPEG 16×16 | `image/jpeg` |
| `video()` | MP4 (H.264) 16×16, 1 s, sem áudio | `video/mp4` |
| `audio()` | MP3 mono, 1 s de silêncio | `audio/mpeg` |
| `voice()` | OGG/Opus mono, 1 s de silêncio | `audio/ogg; codecs=opus` |
| `sticker()` | WebP 512×512 | `image/webp` |
| `animatedSticker()` | WebP animado 512×512, 2 quadros de 500 ms em loop | `image/webp` |
| `gif()` | GIF animado 16×16, 2 quadros de 500 ms em loop | `image/gif` |
| `document()` | PDF de uma página em branco | `application/pdf` |

Cada chamada devolve `{ data, mimetype }` com um `Buffer` novo, então alterar os bytes num teste
não afeta os outros. Para enviar só os bytes, use `fixtures.sticker().data`.

As mídias ficam em base64 em `src/fixtures.ts`, para o pacote não depender de arquivos fora do
`dist`. Para gerar de novo, use o ffmpeg (o PDF foi escrito à mão):

```sh
ffmpeg -f lavfi -i color=c=0x3366cc:s=16x16 -frames:v 1 -q:v 10 image.jpg
ffmpeg -f lavfi -i color=c=0x3366cc:s=512x512 -frames:v 1 -c:v libwebp -lossless 1 sticker.webp
ffmpeg -f lavfi -i color=c=0x3366cc:s=16x16:r=1 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart video.mp4
ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -t 1 -c:a libmp3lame -b:a 8k audio.mp3
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:a libopus -b:a 6k voice.ogg
```

As animadas saem do sharp, juntando dois quadros de cores diferentes:

```js
const frame = (size, background) =>
  sharp({ create: { width: size, height: size, channels: 3, background } }).png().toBuffer();
const frames = async (size) => [await frame(size, '#3366cc'), await frame(size, '#cc6633')];
const animated = { join: { animated: true } };

await sharp(await frames(512), animated)
  .webp({ lossless: true, loop: 0, delay: [500, 500] })
  .toFile('animated-sticker.webp');
await sharp(await frames(16), animated).gif({ loop: 0, delay: [500, 500] }).toFile('animated.gif');
```

Para testar um comando `role: 'owner'`, passe `owners: [DEFAULT_SENDER.phone]` ao
`createTestBot`, ou `owners: [{ id: DEFAULT_SENDER.id }]` para simular uma plataforma sem
telefone.

Um remetente de fora do WhatsApp sai do `sender`: sem telefone, com `@usuario` e com os claims
que o transport verificou. Uma mensagem com `sender: { isBot: true }` é barrada pelo
`ignoreBots`, que vem ligado.

```ts
await bot.receive({
  text: '!notas',
  sender: { id: 'u-42', phone: null, username: 'ana', claims: { papel: 'diretora' } },
});
```

Um chat de fora do WhatsApp sai do `chat`: com o tipo, o espaço e o título. A resposta do
`reply` vai para o `chat.id`:

```ts
await bot.receive({
  text: '!avisos',
  chat: { id: '-100123/45', isGroup: true, kind: 'thread', parentId: '-100123', title: 'Avisos' },
});
```

## Matchers

Os matchers recebem `bot.sent` ou o próprio `TestBot`:

| Matcher | Passa quando |
| --- | --- |
| `toContainText(text?)` | Algum envio é texto. Com `text`, o texto é igual à string ou casa com a RegExp |
| `toContainSticker()` | Algum envio é figurinha |
| `toContainImage()` | Algum envio é imagem |
| `toContainVideo()` | Algum envio é vídeo |
| `toContainAudio()` | Algum envio é áudio (`audio`; a nota de voz é `voice`, outro tipo) |
| `toContainDocument({ fileName?, mimetype? })` | Algum envio é documento. Com `fileName` ou `mimetype`, iguais à string ou casando com a RegExp |
| `toContainTemplate(name?)` | Algum envio é template (`type: 'template'`). Com `name`, o nome é igual à string ou casa com a RegExp |
| `toHaveReplied(text?)` | Algum envio cita uma mensagem, como faz o `ctx.reply`. Com `text`, é uma resposta de texto com esse conteúdo |

Todos funcionam com `.not`. Quando um matcher falha, a mensagem lista o que foi enviado:

```
esperava enviar uma figurinha; enviados:
  - "Mande ou responda uma imagem/vídeo 🙂" (resposta)
```

Para conferir outros detalhes, use os registros direto:
`expect(bot.sent[0]?.content).toEqual({ type: 'sticker', media })`.

Os matchers olham o envio avulso; uma mídia dentro de um álbum (`type: 'album'`) não conta.

### Bytes enviados: `sentMedia()`

`bot.sentMedia(type)` devolve os envios de `image`, `video`, `audio`, `voice`, `sticker` ou
`document`, na ordem, cada um com o registro, o conteúdo já do tipo pedido e os bytes:

```ts
await bot.receive({ text: '!mergepdf' });
const [pdf] = bot.sentMedia('document');
expect(pdf?.content.fileName).toBe('juntos.pdf');
expect(pdf?.bytes?.subarray(0, 5).toString()).toBe('%PDF-');
```

| Campo | Conteúdo |
| --- | --- |
| `sent` | O `SentMessage` (`chatId`, `quoted`, `key`...) |
| `content` | O conteúdo, com `fileName` e `mimetype` no documento |
| `bytes` | O `Buffer` enviado; `null` para mídia por URL (`{ url }`), que o transport falso não baixa |

Mídia dentro de álbum fica de fora, como nos matchers.

## `FakeTransport`

O `FakeTransport` implementa o `Transport` do core sem rede. Ele também serve para testar um
`Bot` montado à mão com `createBot({ transport })`.

```ts
const transport = new FakeTransport({
  capabilities: ['send.text', 'quoted'],  // padrão: as do perfil ou todas
  groups: [{ id: 'grupo@fake', title: 'Grupo', description: null, ownerId: null, participants }],
});
const bot = await createTestBot({ transport, plugins: [meuPlugin()] });
```

| Membro | O que faz |
| --- | --- |
| `profile` | O perfil da criação, ou `undefined` |
| `sent` | Envios: `{ chatId, content, quoted, mentions, key }` |
| `reactions`, `edits`, `deletions` | `react`, `edit` e `delete`, com a `MessageKey` devolvida pelo envio |
| `typing`, `participantUpdates` | `sendTyping` e `updateGroupParticipants` (que cobra `groups.add`, `groups.remove` ou `groups.promote`, conforme a ação) |
| `errors` | Erros lançados pelos handlers de eventos emitidos. O bot trata os próprios erros, então a lista deve ficar vazia |
| `emit(event, payload)` | Simula um evento do canal sem esperar o bot. Prefira o `bot.emit` |
| `setGroup(metadata)` | Registra o grupo que `getGroupMetadata` devolve. Um grupo não registrado faz a chamada falhar |
| `setRaw(source, raw)` / `raw(source)` | Registra e lê o objeto bruto falso de uma mensagem ou interação, o que o `ctx.unsafe.raw()` devolve. Sem registro, `undefined` |
| `clear()` | Esvazia os registros de saída |
| `requestPairingCode(phone)` | Capability `pairing`. Devolve `FAKE-` mais os 4 últimos dígitos do telefone, emite o mesmo código em `connection.pairing-code` e guarda o telefone em `pairingRequests` |
| `logout()` | Capability `pairing`. Soma em `logouts`, zera o `self` e emite `closed` com `logged-out` |

Um método ligado a uma capability que o transport não declara lança `UnsupportedError`, como no
transport real. Um plugin que exige essa capability no manifesto (`requires`) faz o
`createTestBot` rejeitar com `PluginBootError`, com o motivo em `reason`.

### Pareamento e logout pela API

`requestPairingCode` e `logout` atendem às rotas `POST /connection/pairing-code` e
`POST /connection/logout` do core. Para testar o app que conecta o número pela API,
monte o bot com `createBot` e um servidor `createHttp` em loopback:

```ts
const transport = new FakeTransport();
const http = createHttp({ port: 0, hostname: '127.0.0.1' });
const bot = createBot({ transport, http, env: {}, plugins: [comRota] }); // a porta abre com rota
await bot.start();
transport.emit('connection.status', { status: 'connecting' });
const res = await fetch(`http://127.0.0.1:${http.port}/api/connection/pairing-code`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: '5511999991234' }),
});
expect(await res.json()).toEqual({ code: 'FAKE-1234' });
```

### Janela de atendimento

Plataformas como o WhatsApp oficial só aceitam conteúdo livre por um tempo após a última
mensagem do contato. A opção `window` liga essa regra no transport falso:

```ts
vi.useFakeTimers();
const transport = new FakeTransport({ window: { enabled: true, ttlMs: 24 * 60 * 60 * 1000 } });
const bot = await createTestBot({ transport, plugins: [meuPlugin()] });
await bot.receive({ text: 'oi' }); // abre a janela do chat em Date.now()
vi.advanceTimersByTime(25 * 60 * 60 * 1000); // fecha
```

Cada mensagem recebida (`fromMe: false`) abre ou renova a janela do chat. Com a janela fechada
(sem mensagem recebida, ou passado o `ttlMs`), o envio que não é template rejeita com
`ConversationWindowError` (`closedAt` é `null` se o contato nunca escreveu) e não entra em `sent`;
template passa sempre e entra em `sent` (`expect(bot).toContainTemplate('retomar')`).
`transport.window(chatId)` (e o `ctx.send.window`) devolve `{ open, expiresAt }`, com `expiresAt`
`null` se fechada. Sem a opção, ou com `enabled: false`, não há janela: o envio livre passa e
`window()` resolve `null`. A capability `send.template` está em todas as capabilities por padrão,
mas em nenhum perfil de plataforma.

O `self` é `null` até o `connect()` e depois vale o `self` passado nas opções, o do perfil ou
`DEFAULT_SELF`.

## Fora do Vitest: `@usebridger/testing/bot`

O entry principal importa o `vitest` para registrar os matchers. Para subir o bot de teste fora de
um teste, como num benchmark ou num script, importe de `@usebridger/testing/bot`. Ele exporta o
mesmo (`createTestBot`, `FakeTransport`, `fixtures`...), sem os matchers e sem carregar o Vitest.

```ts
import { createTestBot } from '@usebridger/testing/bot';
```

## Limites

- O `settled()` não espera os jobs do scheduler. Para testar um job, chame o handler direto ou
  espere o efeito dele.
