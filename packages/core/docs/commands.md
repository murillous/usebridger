# Comandos

O roteador é o 2º estágio do pipeline ([ADR 0010](../../../docs/adr/0010-pipeline-de-3-estagios.md)):
depois dos middlewares, antes dos listeners. Se a mensagem invoca um comando, ele valida papel e
`accepts`, roda o comando e **consome** a mensagem — ela não chega aos listeners de `message`. No
bot, quem precisa saber que um comando rodou assina o evento [`command`](events.md#comandos-command).

## Declarar um comando

```ts
import { command } from '@usebridger/core';

const sticker = command({
  name: 'sticker',
  aliases: ['s'],
  description: 'Transforma imagem ou vídeo em figurinha',
  accepts: ['image', 'video', 'quoted:image', 'quoted:video'],
  onReject: () => 'Mande ou responda uma imagem/vídeo 🙂',
  role: 'everyone',
  run: async (ctx) => {
    const buffer = await ctx.media!.download(); // própria mensagem OU citada, já resolvido
    // ...
  },
});
```

`command()` valida nome e aliases na hora (não vazios, sem espaço) e devolve a definição.
`registry.add` (e o `ctx.commands.add` do plugin) repete a validação, então uma definição literal
que não passou por `command()` também falha no boot com `TypeError`, em vez de nunca casar. Um
`timeoutMs` que não seja finito e > 0 falha do mesmo jeito, com `RangeError`, assim como um
`concurrency` que não seja inteiro >= 1. Uma entrada de `accepts` com mimetype inválido falha com
`TypeError` ([`accepts` e `ctx.media`](#accepts-e-ctxmedia)), assim como uma capability
desconhecida em `requires`.
O nome vai **sem** o prefixo.

No bot, o `run` que devolve texto (string ou `fmt`) responde com ele, citando a mensagem: o mesmo
que terminar com `await ctx.reply(texto)`, dentro do prazo do comando
([ADR 0075](../../../docs/adr/0075-acucar-no-manifesto-do-plugin.md)). Outro valor não responde
nada, então `run: (c) => c.reply('x')` não responde duas vezes. Comando fixo também pode ir direto
no manifesto, em `commands` ([Plugins → Forma curta](plugins.md#forma-curta-commands-e-on)).

## No bot

O plugin registra com `ctx.commands.add(definição)` no `setup`; o `Bot` monta o roteador com
o prefixo do chat (da config ou de `ctx.prefixes`, ver [Prefixo por chat](#prefixo-por-chat)) e `owners`, liga `isGroupAdmin` ao transport (`isChatAdmin` ou capability `groups`) e chama o
roteador para cada mensagem que passou pelos middlewares ([Bot](bot.md#fluxo-de-uma-mensagem)).
No teardown/reload os comandos do plugin saem sozinhos.

Onde a plataforma tem menu de comandos (Discord, Telegram, web), o transport registra o `name` e
a `description` de cada comando nele, e o `role` decide quem vê: `owner` e papéis custom ficam
fora do menu, mas seguem funcionando digitados. O comando chamado pelo menu roda como o digitado,
sem prefixo, com o texto depois dele como argumentos
([Transport → Comandos nativos](transport.md#comandos-nativos)).

```ts
createBot({ transport, prefix: '!', owners: ['+55 11 99999-9999'], plugins: [media] });
```

## O roteador por dentro

Peça interno do kernel, não exportado ([ADR 0030](../../../docs/adr/0030-biblioteca-sem-runner.md)). Como o `Bot` o monta:

```ts
import { createCommandRouter } from '#commands/router.ts';

const router = createCommandRouter({
  prefix: '!',                         // padrão '!'; vazio é permitido. No bot, uma função do chat
  selfUsername: () => transport.self?.username, // tira o `@bot` de `/cmd@bot`
  owners: ['5511999999999'],           // já normalizados (normalizeOwners)
  isGroupAdmin: async (chat, sender) => {
    const { participants = [] } = await transport.getGroupMetadata(chat.id);
    return participants.some((p) => p.id === sender.id && p.isAdmin);
  },
});

router.registry.add('media', sticker); // 1º argumento: o plugin dono do comando

const result = await router.dispatch(ctx); // ctx: MessageContext
if (!result.consumed) {
  // não era comando: segue para os listeners
}
```

O roteador herda o contexto recebido: `reply` e `log` do `CommandContext` são os do contexto que
o `Bot` monta. Quem usa o roteador solto e quer esses campos os põe no `ctx` passado a
`dispatch`.

## Match

- O texto é o **texto de trabalho** `ctx.text` (no bot, o texto ou legenda da mídia depois dos
  middlewares — truncado pelo `sanitize`, por exemplo), sem os espaços iniciais. Sem `ctx.text`
  no contexto, vale `message.text`; `ctx.text === null` nunca é comando.
- Começa com o prefixo? O **token** é o trecho do fim do prefixo até o primeiro espaço em
  branco. Ele casa por igualdade exata com um nome ou alias registrado — nunca por
  `includes()`/`startsWith()`, então `vou mandar !sticker`, `!stickers` e `!sabado` (com alias
  `s`) não casam.
- **Sem diferenciar caixa** no prefixo e no token: `!Sticker` e `!STICKER` casam com `sticker`.
  Teclado de celular capitaliza a primeira letra sozinho, e o legacy já comparava em
  minúsculas. Os argumentos mantêm a caixa original.
- `! sticker` (espaço depois do prefixo) não é comando.
- **Prefixo vazio:** o token é a primeira palavra. `sticker agora` roda `sticker`.
- **`cmd@usuario` da própria sessão:** com `username` na sessão (`transport.self.username`), o
  roteador tira `@usuario` do fim do token. É como o Telegram endereça um comando ao bot num
  grupo: `/start@MeuBot` casa com `start`, com `invokedAs: 'start'`. `/start@OutroBot` é de outro
  bot e não casa.

## Prefixo por chat

O padrão vem da config, um para todo chat ou um por tipo de chat
([ADR 0059](../../../docs/adr/0059-prefixo-por-chat.md)). `group` vale para todo chat que não é
`dm` (grupo, canal, thread); o tipo omitido fica com `'!'`.

```ts
// Na conversa individual (o widget do ERP), "notas" basta; no grupo, "!notas".
createBot({ transport, prefix: { dm: '', group: '!' }, plugins });
```

Um plugin troca o prefixo de um chat pelo `ctx.prefixes`. O override vale para o bot inteiro e
fica no storage:

```ts
setup(ctx) {
  ctx.commands.add(command({
    name: 'prefixo',
    role: 'group-admin',
    run: async (c) => {
      const [novo] = c.args;
      if (novo === undefined) {
        await ctx.prefixes.reset(c.message.chat.id); // volta ao padrão do tipo de chat
      } else {
        await ctx.prefixes.set(c.message.chat.id, novo);
      }
      await c.reply(`Prefixo agora: "${ctx.prefixes.get(c.message.chat)}"`);
    },
  }));
}
```

- `get(chat)` dá o prefixo em vigor, para mostrar `!ajuda` certo numa mensagem.
- `set` e `reset` gravam no storage e valem na mensagem seguinte. Escritas seguidas terminam na
  ordem em que foram pedidas. Depois do descarte do contexto, rejeitam com
  `ContextExpiredError`.
- Prefixo que começa com espaço em branco lança `TypeError`, na config e no `set`: o texto
  perde os espaços iniciais antes do match, então ele nunca casaria.
- Os overrides são lidos inteiros no boot, antes do `setup` dos plugins. O roteador não vai ao
  storage a cada mensagem.

**Prefixo vazio num grupo.** Toda mensagem que começa com o nome de um comando vira comando:
"ajuda com a matrícula" roda `ajuda` com os argumentos `com a matrícula`. Numa resposta esperada
([Conversas](conversations.md)), responder `ajuda` também roda o comando e cancela a espera.
Prefira o prefixo vazio só na conversa individual.

## Argumentos

O contexto do `run` (`CommandContext`) estende `MessageContext` com:

| Campo | Conteúdo |
| --- | --- |
| `text` | Texto de trabalho que casou (ver [Match](#match)) |
| `reply` | Responde no chat, citando a mensagem, pela fila de saída |
| `log` | Logger com `plugin` (o dono do comando) e `chatId` |
| `t` | Texto de `messages` do plugin com os placeholders preenchidos: `{prefix}` do chat e os valores passados ([Config](config.md#placeholders)) |
| `command` | Nome canônico do comando casado |
| `invokedAs` | Token digitado (nome ou alias), em minúsculas |
| `args` | Argumentos já quebrados (ver abaixo) |
| `rawArgs` | Texto após o token, sem o espaço inicial, com quebras de linha |
| `accepted` | `{ spec, message }` da entrada de `accepts` que casou, ou `null` |
| `media` | Mídia resolvida, ou `null` |

`args` quebra por qualquer espaço em branco (inclusive quebra de linha). Trecho entre aspas
vira um argumento só, sem as aspas: `!persona criar "Luma séria"` → `['criar', 'Luma séria']`.

- Valem `"..."` e as tipográficas `“...”` (o iOS troca uma pela outra).
- Aspas simples **não** agrupam: o apóstrofo aparece em texto comum (`d'água`).
- `""` gera argumento vazio; aspa sem fechamento vai até o fim do texto.
- Sem escape (`\"`): quem precisa do texto literal usa `rawArgs`.

Para subcomandos, use `ctx.args` direto: `const [sub, ...resto] = ctx.args`.

## `accepts` e `ctx.media`

Cada entrada é um `MessageType` da própria mensagem (`'image'`) ou da citada
(`'quoted:image'`). A **primeira entrada que casar, na ordem declarada**, vence e define
`ctx.accepted` e `ctx.media` (a mídia daquela mensagem; `null` para tipos sem mídia, como
`'quoted:text'`). Para preferir a mídia própria, liste os tipos próprios antes dos `quoted:*`.

Um tipo com mídia (`image`, `video`, `audio`, `voice`, `sticker`, `document`) pode restringir o
mimetype depois de mais um `:`, exato ou com curinga no subtipo:

```ts
command({
  name: 'mergepdf',
  accepts: ['document:application/pdf', 'quoted:document:application/pdf'],
  onReject: () => 'Mande ou responda um PDF',
  run: async (ctx) => { /* ctx.media é um PDF */ },
});
// 'video:video/*', 'image:image/gif', 'quoted:audio:audio/ogg'
```

A comparação usa só a essência do mimetype, sem diferenciar caixa: `audio/ogg; codecs=opus` casa
com `'audio:audio/ogg'`. A mídia de outro mimetype não casa aquela entrada, e o roteador tenta a
próxima; se nenhuma casar, a recusa vai ao `onReject` como sempre. Mimetype mal formado, ou num
tipo sem mídia (`'text:text/plain'`), falha na definição com `TypeError`.

`'args'` casa quando há texto depois do comando (`ctx.rawArgs` não vazio). É o que serve para
"mídia **ou** um argumento": `'text'` não ajuda, porque o próprio comando é texto e casaria sempre.
Com `!sticker` declarando `['sticker', 'quoted:sticker', 'args']`, `!s https://...` roda com
`ctx.accepted.spec === 'args'` e `ctx.media` nulo, e o `!s` sozinho, sem mídia, cai no `onReject`.
`'args'` é só da própria mensagem: `'quoted:args'` ou `'args'` com mimetype falham com `TypeError`.

Sem `accepts`, qualquer mensagem passa; `ctx.media` é a mídia própria ou, na falta dela, a da
citada.

### `ctx.media` garantido

`command()` e o `commands` do `definePlugin` inferem o `accepts` declarado. Quando **toda**
entrada tem mídia, o `run` recebe um `MediaCommandContext`: `ctx.media` é `Media` e
`ctx.accepted` é `AcceptedMessage`, sem `null`, porque o roteador só chega ao `run` depois de
casar uma delas. Basta uma entrada sem mídia (`'args'`, `'quoted:text'`) para voltar ao
`CommandContext`, com `Media | null`.

```ts
command({
  name: 'image',
  accepts: ['sticker', 'quoted:sticker'],
  run: async (ctx) => ctx.media.download(), // sem `!` nem checagem
});
```

O estreitamento vem do literal: um `accepts` guardado numa variável tipada `AcceptSpec[]`, ou um
comando passado direto a `ctx.commands.add` sem `command()`, fica com o contexto largo. Um helper
fora do `run` pode receber `MediaCommandContext`.

## `role`

| Papel | Quem roda |
| --- | --- |
| `everyone` (padrão) | Todo mundo |
| `owner` | Remetente cujo `sender.phone` (ou `sender.id`, para `{ id }`) está em `owners` |
| `group-admin` | Admin do grupo, segundo a porta `isGroupAdmin(chat, sender)` |

- Owner passa também em `group-admin`.
- `group-admin` fora de grupo é recusado (não há grupo a que o papel se refira).
- No bot, quem responde é o `transport.isChatAdmin(chat, sender)`, se o transport o implementa
  (Discord, Telegram: [ADR 0055](../../../docs/adr/0055-grupos-multiplataforma.md)).
- Sem ele, o remetente é admin se um participante admin do `getGroupMetadata` tem o mesmo `id`
  ou, quando os dois lados o têm, o mesmo `phone`: numa plataforma em que o mesmo contato tem IDs
  de espaços diferentes (o WhatsApp), o remetente e o participante podem vir cada um num. Sem
  telefone de um lado, só o `id` decide
  ([ADR 0042](../../../docs/adr/0042-ids-de-contato-e-metadata-de-grupo.md)). Metadata sem
  `participants` recusa.
- Sem `isGroupAdmin` (transport sem `isChatAdmin` e sem a capability `groups`), `group-admin`
  recusa todo mundo exceto owners: falha fechada, nunca libera por falta de informação.
- Um owner telefone (`'5511999999999'`, só dígitos e DDI) é comparado por igualdade com
  `message.sender.phone`. O bot normaliza a lista da config com `normalizeOwners`, então lá vale
  `'+55 (11) 99999-9999'`; no roteador solto, normalize antes.
- O telefone não é comparado com `sender.id`: o ID é opaco e nem sempre carrega o número. Só o
  transport sabe resolvê-lo; quando não sabe, `phone` é `null` e esse remetente só é owner se
  estiver na lista por `{ id }`.
- Um owner `{ id }` é comparado por igualdade com `message.sender.id`, para plataformas sem
  telefone (Discord, Telegram, web). Telefone e ID nunca se cruzam
  ([ADR 0052](../../../docs/adr/0052-owners-por-telefone-ou-id.md)).

### Papéis custom

Um plugin define um papel nomeado no `setup`, e qualquer plugin o exige no comando
([ADR 0031](../../../docs/adr/0031-papeis-nomeados-por-plugin.md)). O nome é tipado por
declaration merging, como os serviços:

```ts
declare module '@usebridger/core' {
  interface Roles { moderador: true }
}

// plugin "moderacao"
setup(ctx) {
  ctx.roles.define('moderador', async (c) => {
    const lista = await ctx.storage.kv.get('moderadores');
    return Array.isArray(lista) && lista.includes(c.message.sender.id);
  });
}

// outro plugin, com dependsOn: { moderacao: '^1.0.0' }
ctx.commands.add(command({ name: 'ban', role: 'moderador', run: (c) => c.reply('banido') }));
```

- O `check(c)` recebe `message`, `text`, `command` (o comando que exige o papel), `log` (do
  plugin dono do papel) e `signal`. Só `true` concede.
- **Owner passa** em qualquer papel, sem chamar o `check`.
- **Fail-closed**: `check` que lança, rejeita ou estoura `timeouts.commandMs` recusa o comando e
  vira `plugin.error` (`phase: 'role'`, `event` = papel) **do plugin dono do papel**. No prazo, o
  `signal` aborta com `RoleTimeoutError`. Checagem síncrona não cria timer.
- Papel que nenhum plugin carregado define (dono desligado, ignorado ou recarregando) recusa o
  comando e loga um erro que pede o `dependsOn` no dono do papel.
- `owner`, `group-admin` e `everyone` são reservados (`TypeError`). Definir um papel que já tem
  dono, de outro plugin ou do mesmo, lança `RoleConflictError` (`role`, `existing`, `incoming`).
  No boot, isso derruba o `start()`, como conflito de comando ou de serviço (ADR 0031); num
  reload, o plugin recarregado fica ignorado.
- O papel sai no teardown/reload do plugin que o definiu.

Fora do bot, passe `roles` (de `createRoleRegistry()`) e, se quiser, `onUnknownRole` às opções
do roteador; o `check` cru não tem prazo nem fail-closed para erros, que viram `failed`.

### Comandos que o remetente pode rodar

Um menu de ajuda mostra a cada pessoa só o que ela pode rodar. `ctx.commands.list({ for: message })`
devolve os comandos cujo papel o remetente de `message` passa, na ordem de registro:

```ts
command({
  name: 'ajuda',
  run: async (c) => {
    const comandos = await ctx.commands.list({ for: c.message });
    return comandos.map((info) => `!${info.name}: ${info.description ?? ''}`).join('\n');
  },
});
```

- A regra é a do roteador: owner passa em todos, `group-admin` só em grupo, e o papel custom
  chama o `check` do plugin dono, com o mesmo prazo e fail-closed. O `check` recebe o `command`
  de cada comando avaliado e o texto original da mensagem em `text`.
- A consulta de admin do grupo sai uma vez por chamada, não uma por comando.
- Não confere `accepts`: o comando aparece mesmo que a mensagem atual não traga a mídia pedida.
- Nunca rejeita. Uma consulta que falha (o transport fora do ar, por exemplo) tira o comando da
  lista e loga um `warn` no plugin que chamou; papel sem dono recusa e loga como no roteador.
- Sem `for`, `list()` segue síncrono e devolve todos os comandos.

Fora do bot, o roteador oferece o mesmo como `router.allowed({ message, text, log, signal })`,
que devolve os `RegisteredCommand`.

## Recusa e `onReject`

A ordem é: papel → `accepts` → `run`. Na recusa, o roteador chama
`onReject(ctx, rejection)`, com `rejection` igual a `{ reason: 'role', required }` ou
`{ reason: 'accepts', accepts }`. O texto retornado volta em `result.reply`; no bot, ele sai pelo
`ctx.reply` (citando a mensagem). Sem `onReject`, ou retornando
`null`/`undefined`, a recusa é silenciosa (`reply: null`). Comando recusado também consome a
mensagem.

## Resultado de `dispatch`

`dispatch` nunca rejeita a promise. O resultado diz o que aconteceu:

| `status` | `consumed` | Extra |
| --- | --- | --- |
| `no-match` | `false` | — |
| `ran` | `true` | `command` |
| `rejected` | `true` | `command`, `rejection`, `reply` |
| `failed` | `true` | `command`, `error` (de `run`, `onReject` ou `isGroupAdmin`, ou o prazo de um deles no bot) |
| `background` | `true` | `command`, `done` (comando com `background: true`: resolve com `ran` ou `failed` quando o `run` termina, nunca rejeita) |

`command` é `{ plugin, name, invokedAs }`. Quem chama decide o destino do erro de `failed`; no
bot, vira `plugin.error` (`phase: 'command'`) e log em `error`.

O roteador em si não tem prazo. No bot, o `run` e o `onReject` de cada comando têm prazo de
`timeouts.commandMs` (padrão 30 s), contado à parte para cada um: estourado, `dispatch` devolve
`failed` com um `CommandTimeoutError` (`stage: 'run'` ou `'onReject'`), o `plugin.error` sai com
`timedOut: true` e o chat é liberado. O código segue em segundo plano; uma rejeição tardia vai
só para o log ([Bot](bot.md#fluxo-de-uma-mensagem)). A porta `isGroupAdmin` que o bot liga ao
transport tem o mesmo prazo e, estourada, rejeita com `GroupAdminTimeoutError`: o comando não
roda (`failed`), nunca é liberado por falta de resposta.

O comando que legitimamente demora (download, conversão) declara o próprio prazo com `timeoutMs`,
que vale para o `run` e o `onReject` dele. Sem `timeoutMs`, vale o `commandMs` do bot:

```ts
command({
  name: 'download',
  timeoutMs: 300_000, // yt-dlp + upload; os outros comandos seguem com o padrão
  run: async (c) => {
    const video = await baixar(c.rawArgs, { signal: c.signal });
    await c.reply.video(video);
  },
});
```

Enquanto roda, o comando segura o chat dele ([ADR 0038](../../../docs/adr/0038-handler-lento-segura-o-chat.md)):
um prazo de 5 min deixa as mensagens seguintes daquele chat esperando até 5 min. A consulta de
admin e os papéis custom seguem com o `commandMs`.

### Comando em segundo plano

Se o grupo não deve esperar, declare `background: true`
([ADR 0083](../../../docs/adr/0083-comando-em-segundo-plano.md)). Papel, `accepts` e `onReject`
continuam na fila do chat; o `run` começa ali e a próxima mensagem do chat segue sem esperá-lo:

```ts
command({
  name: 'download',
  background: true,
  timeoutMs: 240_000,
  run: async (c) => {
    await c.reply('baixando…');
    const video = await baixar(c.rawArgs, { signal: c.signal });
    await c.reply.video(video); // cita a mensagem original
  },
});
```

O `run` mantém tudo o que teria na fila: `reply`, `react`, `log`, `expectReply` e o `signal` com o
`timeoutMs`. A falha, inclusive o prazo, vai para `plugin.error`, e o evento `command` sai quando o
`run` termina, com `ran` ou `failed`. O `bot.settled()` espera o `run`. No reload ou no `stop()`, o
`signal` aborta quando o plugin desce; o `run` não é drenado.

Em troca, o `run` não tem ordem com as mensagens seguintes, e duas execuções do mesmo chat podem
terminar fora de ordem. Quem guarda estado por conversa e precisa de ordem não usa `background`.

### Limite de concorrência

O rate limit de entrada conta mensagens, não custo, e a fila paraleliza entre chats: dez chats
mandando `!download` sobem dez yt-dlp juntos. `concurrency` põe um teto de `run` simultâneos do
comando no bot, somando todos os chats
([ADR 0084](../../../docs/adr/0084-limite-de-concorrencia-por-comando.md)):

```ts
command({
  name: 'download',
  background: true,
  concurrency: 2, // no máximo dois downloads ao mesmo tempo
  timeoutMs: 240_000,
  run: async (c) => {
    const video = await baixar(c.rawArgs, { signal: c.signal });
    await c.reply.video(video);
  },
});
```

A execução excedente espera a vez em ordem de chegada, depois do papel e do `accepts`. A espera
conta no `timeoutMs`: estourado na fila, o `run` nem começa, e sai o `plugin.error` com
`CommandTimeoutError` de sempre. A vaga volta quando o `run` termina de fato, não quando o prazo
estoura: um `run` que ignora o `signal` continua ocupando a CPU e a vaga. Sem `background`, quem
espera segura o chat dele, como o `run` seguraria; com `background`, a espera também sai da fila
do chat.

O teto é por registro do comando: no reload, o plugin novo começa com o teto inteiro, e os `run`
antigos ainda vivos não contam nele. O roteador solto ignora `concurrency`, como o `timeoutMs`.

### Capability por comando

O `requires` do plugin vale para ele inteiro: num plugin com comandos que enviam tipos diferentes,
exigir tudo derruba os que funcionariam. `requires` no comando exige a capability só dele
([ADR 0086](../../../docs/adr/0086-requires-por-comando.md)):

```ts
ctx.commands.add(command({
  name: 'figurinha',
  requires: ['send.sticker'],
  run: async (c) => { /* ... */ },
}));
```

Sem alguma delas, o comando não é registrado: não casa no roteador, fica fora do
`ctx.commands.list()` e do menu nativo da plataforma, e o resto do plugin sobe normalmente. Quem
digita o comando recebe o mesmo que receberia de um comando que não existe, então o aviso é para o
operador: um log `warn` com `plugin`, `command` e `missing`, e o comando na linha do plugin na
[tabela de boot](plugins.md#boot-start) (`media  1.0.0  carregado; sem figurinha (send.sticker)`),
que também sobe para `warn`. Em `bot.plugins()`, a linha do plugin traz `unregistered`, com
`command` e `missing` de cada um. A definição continua validada mesmo sem a
capability, então um nome inválido falha em qualquer transport. O roteador solto ignora
`requires`, como o `timeoutMs`.

### Serviço por comando

Um comando que usa o serviço de outro plugin, num plugin que funciona sem ele, declara o serviço
em `services` ([ADR 0095](../../../docs/adr/0095-comando-que-exige-servico.md)). Com o provedor
em `optionalDependsOn` no manifesto, o comando some e volta junto com ele:

```ts
export const download = definePlugin({
  name: 'download',
  version: '1.0.0',
  engine: '^1.0.0',
  optionalDependsOn: { sticker: '^0.1.0' }, // carrega depois do sticker e recarrega com ele, se existir
  commands: {
    downloadsticker: {
      requires: ['send.sticker'],
      services: ['sticker'],
      run: async (c, plugin) => {
        const stickers = plugin.services.get('sticker'); // provido: senão o comando não existiria
        /* ... */
      },
    },
  },
});
```

Na hora do registro (`ctx.commands.add`, também o dos `commands` do manifesto), se algum serviço
de `services` não está provido, o comando fica de fora como o sem capability: fora do roteador, do
`ctx.commands.list()` e do menu nativo, com um log `warn` com `plugin`, `command` e `services`, e
na tabela de boot como `sem downloadsticker (serviço sticker)`. Em `unregistered`, a entrada traz
`services` com os que faltavam e `missing` vazio.

A conferência é só no registro. Quem a refaz quando o provedor sobe, falha, recarrega, é
desligado ou ligado é o reload em cascata do `optionalDependsOn`
([Plugins](plugins.md#recarregar-um-plugin-reload)): o plugin desce e sobe junto, e o `setup` novo
registra o comando ou o deixa de fora. Sem `optionalDependsOn` (ou `dependsOn`) no provedor, o
comando fica como estava no boot. Serviço que o próprio plugin provê conta se o `provide` vier
antes do `add`. O roteador solto ignora `services`.

Para perguntar algo e tratar a resposta, o `run` não espera a próxima mensagem: ela está na fila
atrás dele. Ele envia a pergunta, chama `c.expectReply(passo)` e termina, e a resposta vai ao
passo ([Conversas](conversations.md)). Um comando digitado enquanto a espera vale a cancela e
roda normalmente.

### `ctx.signal` e o que acontece depois do prazo

No bot, o contexto do `run` traz `signal: AbortSignal`, que aborta quando o prazo estoura
(`reason` = o `CommandTimeoutError`) ou quando o plugin é descartado (teardown, reload), com o
motivo do descarte. Repasse-o a `fetch` e SDKs, para o trabalho parar junto
([ADR 0029](../../../docs/adr/0029-cancelamento-cooperativo.md)):

```ts
command({
  name: 'resumo',
  run: async (c) => {
    const texto = await ia.resumir(c.rawArgs, { signal: c.signal });
    await c.reply(texto);
  },
});
```

Depois do prazo, `c.reply(...)` (e `c.reply.image(...)` etc., mesmo guardado antes) rejeita com
`ContextExpiredError` sem chegar ao transport, com uma linha `warn` (plugin e comando). O
`ctx.send`/`ctx.storage` do `setup` são do plugin e não sabem do prazo do comando: confira
`c.signal.aborted` (ou `c.signal.throwIfAborted()`) antes de efeitos que não recebem o `signal`.
Código síncrono travado bloqueia o processo inteiro, e nenhum prazo resolve isso.

O `onReject` recebe o próprio `signal`, que aborta quando o prazo dele estoura, e o `reply` dele
segue a mesma regra. Fora do bot, o roteador não cria `signal`: quem chama `dispatch` o fornece
no contexto, como `reply` e `log`.

## Conflitos

Nome e aliases são únicos no bot inteiro, sem diferenciar caixa. `registry.add` lança
`CommandConflictError` se algum token já pertence a outro comando — de outro plugin ou do mesmo —
e não registra nada do comando recusado. O erro traz `token`, `existing` e `incoming` (cada um
com `plugin` e `definition`), e a mensagem cita os dois plugins:

```
Conflito de comando "s": "search" do plugin "busca" colide com "sticker" do plugin "media".
```

Como os comandos são registrados no `setup` dos plugins, o conflito derruba o boot: o `Bot`
encerra o que subiu e o `start()` rejeita com o `CommandConflictError`. Alias
repetido ou igual ao próprio nome dentro do mesmo comando é inofensivo e não conta.

`registry.removePlugin(nome)` tira todos os comandos de um plugin (teardown e reload).
