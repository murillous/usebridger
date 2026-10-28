# Plugins

Esta página explica como um plugin é montado e o que o core faz por ele: capabilities, serviços
entre plugins, dados, agendamento, texto formatado e o escape hatch.

Um plugin é um objeto criado por `definePlugin`: um **manifesto** (nome, versão, faixa do core, o
que ele exige) mais o comportamento. O kernel lê o manifesto antes de rodar qualquer código do
plugin, e é isso que permite recusar o incompatível no boot em vez de falhar no meio de uma
conversa.

```ts
import { definePlugin } from '@usebridger/core';

export const ola = definePlugin({
  name: 'ola',
  version: '1.0.0',
  engine: '<1.0.0', // faixa do core com que foi testado
  commands: {
    ola: { description: 'Cumprimenta', run: () => 'Olá!' }, // devolver texto responde
  },
});
```

## Manifesto e setup

Há duas formas de declarar o comportamento, e elas levam ao mesmo lugar:

- **`commands` e `on` no manifesto**: um objeto nome → comando e outro evento → listener. É a
  forma curta, e o que o template gera. O `run` que devolve texto responde.
- **`setup(ctx)`**: uma função que roda no boot com o contexto do plugin e registra o que quiser
  com `ctx.commands.add`, `ctx.events.on` e o resto da API.

Por dentro, o host registra os `commands` e os `on` do manifesto com as mesmas chamadas do
`setup`, antes do `setup` do plugin. Prazo, conflito de nome, teardown e reload são idênticos. A
forma curta não é outra API: é a mesma, sem a cerimônia.

Use o manifesto para o que é fixo, e o `setup` para o que depende de algo resolvido no boot:

- oferecer ou consumir um service, registrar handlers de job (`ctx.scheduler.on`), passos de
  conversa, papéis custom e rotas HTTP;
- vários listeners do mesmo evento, ou listener com filtro e prioridade;
- comandos que dependem da config.

```ts
import { command, definePlugin } from '@usebridger/core';

definePlugin({
  name: 'lembrete',
  version: '1.0.0',
  engine: '<1.0.0',
  setup(ctx) {
    ctx.scheduler.on('avisar', async (payload) => {
      const { chatId } = payload as { chatId: string };
      await ctx.send.send(chatId, 'Hora do lembrete!');
    });
    ctx.commands.add(
      command({
        name: 'lembrar',
        run: async (c) => {
          await ctx.scheduler.at(new Date(Date.now() + 60_000), 'avisar', { chatId: c.message.chat.id });
          return 'Aviso em 1 minuto.';
        },
      }),
    );
  },
});
```

As duas formas convivem no mesmo plugin.

## Exigir uma capability ou conferir

Cada transport declara capabilities, e o plugin escolhe como lidar com cada uma:

- **Exigir em `requires`** quando o plugin não faz sentido sem ela. Um plugin de figurinhas sem
  `send.sticker` não tem o que fazer. Num transport sem a capability, o boot para antes de
  conectar e diz o que faltou; para subir o bot sem esse plugin, o operador o põe em
  `disabledPlugins`.
- **Conferir em `ctx.capabilities.has(...)`** quando ela é um extra. O plugin sobe em todo
  transport e usa o recurso onde ele existe, com outro caminho onde não existe.
- **Exigir num comando só**, com `command({ requires })`, quando um comando depende dela e o resto
  do plugin não. Sem a capability, só aquele comando fica de fora do roteador, da ajuda e do menu
  nativo.

```ts
definePlugin({
  name: 'figurinhas',
  version: '1.0.0',
  engine: '<1.0.0',
  requires: ['send.sticker'], // sem a capability, o boot para e diz o que faltou
  setup(ctx) {
    if (ctx.capabilities.has('reactions')) {
      // usa reação onde existe; segue sem ela onde não existe
    }
  },
});
```

A regra é **exigir o mínimo**: cada capability em `requires` tira o plugin de uma plataforma
inteira. `commands` no manifesto já soma `send.text`. Em runtime, usar uma capability que o
transport não tem rejeita com `UnsupportedError`; isso é a rede de segurança, não o caminho
normal.

## Mídia, botões, enquetes e reações

Mídia, botões, enquetes e reações são capabilities, e cada uma tem um comportamento definido onde
falta, escolhido pelo que faz sentido para quem está do outro lado:

| Recurso | Sem a capability |
| --- | --- |
| Enviar imagem, vídeo, áudio, documento, figurinha, álbum | Rejeita com `UnsupportedError`; exija em `requires` ou confira antes |
| Botões (`reply(texto, { actions })`) | O kernel acrescenta uma lista numerada ao texto e aceita o número como resposta |
| Reação pelo atalho do contexto (`c.react`) | Não faz nada e registra em `debug`: a reação é enfeite |
| Reação por `ctx.send.react` | Rejeita: é o caminho de quem precisa saber se saiu |
| Enquete (`reply.poll`) | Rejeita; confira `polls` antes |
| Texto formatado | Sai sem a marcação, como texto visível |

### Guardar uma mídia para depois

Com a capability `media.ref` (WhatsApp e Telegram), o plugin guarda uma **referência** da mídia,
um JSON pequeno, em vez dos bytes, e baixa depois, mesmo após um restart:

```ts
// ao receber: guarda só a referência
const ref = ctx.media.ref(c.message.media);
// depois: volta a ter uma mídia que se baixa sob demanda
const buffer = await ctx.media.fromRef(ref).download();
```

Se a plataforma já não tem o arquivo, o download rejeita com `MediaExpiredError`. Trate a
referência como segredo: no WhatsApp ela leva a chave que decifra o arquivo.

A matriz do que cada transport suporta está em [Capabilities](../guias/capabilities.md#matriz-por-transport).

## Texto formatado em qualquer plataforma

Cada plataforma marca negrito de um jeito (`*a*`, `**a**`, HTML). O plugin portátil escreve com
os helpers do core, `` fmt`Notas de ${bold(nome)}` ``, que montam uma árvore neutra, e o
transport a traduz para a marcação dele, com o escape certo.

```ts
import { bold, fmt, mention } from '@usebridger/core';

await c.reply(fmt`Notas de ${bold(nome)}, ${mention(c.message.sender)}`);
```

Duas propriedades importam mais que a sintaxe: o valor interpolado é **literal** (um `*` digitado
pelo usuário não vira negrito nem quebra a marcação), e `mention(contato)` gera a menção certa em
cada plataforma. Texto cru continua aceito e vai como veio, para o plugin de uma plataforma só.

## Um plugin que usa outro

Plugins conversam por **services**, nunca importando o estado um do outro:

- o provedor publica com `ctx.services.provide('traducao', impl)`;
- o consumidor declara `dependsOn: { traducao: '^1.0.0' }` e pega com `ctx.services.get`;
- o tipo vem por declaration merging na interface `Services`, exportada pelo pacote do provedor.

```ts
// provedor
ctx.services.provide('traducao', { traduzir: async (texto: string) => '...' });

// consumidor
definePlugin({
  name: 'resumo',
  version: '1.0.0',
  engine: '<1.0.0',
  dependsOn: { traducao: '^1.0.0' },
  setup(ctx) {
    const traducao = ctx.services.get('traducao');
  },
});
```

Por que um registry em vez de `import`? Porque o serviço é **uma instância viva**, com a config
e o storage do provedor, e pode ser recarregado. O `import` daria o código, não a instância que o
bot carregou. Quando o provedor recarrega, quem depende dele por `dependsOn` recarrega junto, para
não ficar segurando um serviço de um contexto já descartado.

Os campos de ordem e dependência servem a coisas diferentes:

| Campo | Ordena a carga | Sem o outro plugin | Recarrega junto |
| --- | --- | --- | --- |
| `dependsOn` | sim | o boot para (ou o consumidor fica fora, num reload) | sim |
| `optionalDependsOn` | sim | sobe; confira com `ctx.services.has` | sim |
| `after` | sim | sobe | não |
| `priority` | entre os que não têm aresta, maior primeiro | — | não |

`command({ services: [...] })` faz pelo service o que o `requires` por comando faz pela
capability: sem o serviço, só aquele comando fica de fora.

### Estender outro plugin

Quando outros plugins acrescentam peças a um serviço (etapas de um pipeline, formatos de um
exportador), o provedor abre um **ponto de extensão** e os outros contribuem com
`ctx.services.contribute(nome, peça)`. O kernel sabe de quem é cada contribuição e a retira
quando aquele plugin desce, recarrega ou é desligado, coisa que um `Set` guardado pelo provedor
não saberia fazer.

## Onde guardar dados

`ctx.storage` dá ao plugin um espaço só dele, com duas formas:

- **KV**, para valores avulsos por chave (`kv.get`, `kv.set`);
- **coleções**, para documentos com filtro, ordenação, limite e índices declarados.

```ts
await ctx.storage.kv.set('ultimo-comando', Date.now());
const visto = await ctx.storage.kv.get<number>('ultimo-comando');
```

Não há SQL cru: a mesma chamada funciona no SQLite, no Postgres e na memória dos testes, e o
plugin não sabe qual está embaixo. Os valores são JSON e voltam sempre como cópia.

O escopo é automático em três níveis, para o plugin não precisar compor chaves:

- **sessão**: cada bot tem seus dados ([Bot e sessão](bot-e-sessao.md#sessão));
- **tenant**: num transport com clientes separados (o web, com o tenant vindo do token), o mesmo
  `ctx.storage` resolve os dados do cliente da mensagem corrente, inclusive em services e timers
  iniciados ali;
- **compartilhado**: `ctx.storage.shared` é do plugin em todas as sessões, para um dado comum a
  vários números.

O plugin nunca alcança os dados de outro plugin nem os do kernel. Para dividir dados, ofereça um
service.

## Agendar e o que sobrevive a um restart

`ctx.scheduler.at(quando, job, payload)` agenda uma vez, `ctx.scheduler.every(regra, job)` repete
(`{ everyMs }` ou `{ time: 'HH:mm', timeZone }`), e `ctx.scheduler.on(job, handler)`, registrado no
`setup`, trata. O job fica no storage e dispara **pelo menos uma vez**: só sai depois que o
handler termina, então um crash no meio faz o job rodar de novo no boot. O handler deve tolerar
uma repetição rara ([Scheduler](../guias/scheduler.md#pelo-menos-uma-vez)).

| Sobrevive a um restart | Se perde |
| --- | --- |
| Dados do `ctx.storage` | `setTimeout` e estado em variáveis do plugin |
| Jobs do scheduler | Esperas de conversa sem `persist: true` |
| Esperas de conversa com `persist: true` | Botões enviados (o clique depois do restart é ignorado) |
| Overrides de config e credenciais da sessão | O que estava na fila de saída |

## Erros e cancelamento

O plugin não precisa de `try/catch` para proteger o bot: o kernel isola cada execução e reporta a
falha. Ele trata erro quando quer **dizer algo ao usuário** ou **tentar de novo**. O que o plugin
precisa respeitar é o `signal`: repassá-lo a `fetch` e SDKs, e não insistir em efeitos depois do
prazo, quando o contexto os recusa com `ContextExpiredError`. O modelo inteiro está em
[O caminho da mensagem → prazos](mensagem.md#prazos-e-cancelamento).

## Escape hatch e o preço dele

A API do core cobre o que as plataformas têm em comum. Para o resto, `ctx.unsafe.native` dá o
cliente da biblioteca (o socket do Baileys) e `ctx.unsafe.raw(message)` dá o objeto original da
mensagem, ambos como `unknown`.

O preço:

- o plugin fica **preso ao transport**: declare `transports: ['baileys']`, para o boot recusá-lo
  nos outros em vez de ele quebrar;
- o tipo é seu: o formato da biblioteca muda sem o semver do Bridger;
- nada do kernel vale ali: um envio pelo socket pula a fila de saída, e com ela o ritmo anti-ban e
  o retry;
- o primeiro uso loga um `warn` com o plugin e o transport.

```ts
definePlugin({
  name: 'so-whatsapp',
  version: '1.0.0',
  engine: '<1.0.0',
  transports: ['baileys'], // o boot recusa este plugin em outros transports
  setup(ctx) {
    const socket = ctx.unsafe.native as WASocket; // o tipo é seu
  },
});
```

O aviso é proposital: o que os plugins buscam fora da API é o que vira API depois. Se o que falta é
comum a várias plataformas, abra uma issue: a lacuna é do core.
