# Plugins: manifesto, loader e lifecycle

Toda feature do bot é um plugin ([ADR 0006](../../../docs/adr/0006-luma-e-um-plugin.md)); o core
não importa nenhuma. O loader junta os plugins da config e das pastas, valida o manifesto,
decide quem carrega, ordena e roda `setup`/`teardown` com prazo
([ADRs 0005](../../../docs/adr/0005-plugins-no-mesmo-processo.md),
[0007](../../../docs/adr/0007-plugins-via-npm-e-pasta.md),
[0016](../../../docs/adr/0016-manifesto-do-plugin.md)).

## Declarar um plugin

Para começar um plugin em pacote próprio, com teste e build prontos, use o scaffold:
`npm create bridger-plugin@latest bridger-plugin-<nome>`
([create-bridger-plugin](../../create-plugin/docs/README.md)).

```ts
import { command, definePlugin } from '@usebridger/core';
import { z } from '@usebridger/core/zod';

export const sticker = definePlugin({
  name: 'sticker',                              // kebab-case, único no bot
  version: '1.2.0',                             // semver do plugin
  engine: '^1.0.0',                             // faixa do @usebridger/core — obrigatório
  requires: ['media.download', 'send.sticker'], // capabilities do transport
  transports: ['baileys'],                      // opcional: fixa o(s) transport(s)
  dependsOn: { 'user-names': '^1.0.0' },        // opcional: plugin → faixa semver
  after: ['logger-extra'],                      // opcional: carrega depois, se existir
  optionalDependsOn: { ai: '^1.0.0' },          // opcional: como dependsOn, sem impedir a carga
  priority: 0,                                  // opcional: maior carrega antes

  config: z.object({ quality: z.number().min(1).max(100).default(80) }),
  messages: { needMedia: 'Mande ou responda uma imagem/vídeo 🙂' },

  setup(ctx) {
    ctx.config.quality;          // number — sai de z.output do schema
    ctx.plugin.messages.needMedia; // só as chaves declaradas em `messages`
    ctx.commands.add(command({ name: 'sticker', run: async (c) => { /* ... */ } }));
    // Papel que qualquer plugin pode exigir no comando (ver commands.md, "Papéis custom").
    ctx.roles.define('moderador', (c) => moderadores.has(c.message.sender.id));
  },

  teardown(ctx) { /* libera o que o setup abriu fora do ctx */ },
});
```

`definePlugin` valida o manifesto na hora e lança `PluginManifestError` com **todos** os
problemas encontrados. Regras:

| Campo | Regra |
| --- | --- |
| `name` | kebab-case minúsculo começando por letra (`/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`), até 64 caracteres. Vira chave de `disabledPlugins`, namespace de storage e prefixo de rota, então não muda entre versões. |
| `version` | semver exato (`1.2.0`, `1.0.0-beta.1`). |
| `engine` | faixa semver, obrigatória, conferida contra `CORE_VERSION`. |
| `requires` | capabilities de `CAPABILITIES`; o TypeScript já recusa nome errado. Para exigir só num comando, use o `requires` dele ([Comandos](commands.md#capability-por-comando)). |
| `transports` | lista não vazia de nomes de transport. |
| `dependsOn` | nome de plugin → faixa semver; não pode citar o próprio plugin. |
| `after` | nomes de plugin; não pode citar o próprio plugin. |
| `optionalDependsOn` | nome de plugin → faixa semver, como o `dependsOn`; não pode citar o próprio plugin nem repetir um nome do `dependsOn` ([Serviço opcional](services.md#serviço-opcional)). |
| `priority` | número finito; padrão 0. |
| `config` | schema Zod ([Config](config.md#declarar)). |
| `messages` | objeto chave → texto. |
| `commands` | objeto nome → comando, cada um com `run` função; o nome segue as regras do `command()` (ver abaixo). |
| `on` | objeto evento → função; o evento tem que existir em `BotEvents` (erro de digitação é recusado). |
| `setup` | função; opcional quando o plugin declara `commands` ou `on`. |
| `teardown` | função, se presente. |

Faixas aceitas: `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, curingas (`*`, `x`, `1.x`, `1.2`),
comparadores separados por espaço (E) e `||` (OU) — a semântica do npm, inclusive a de
pré-release: `^1.0.0` não aceita `1.1.0-beta`. Faixas com hífen (`1.0.0 - 2.0.0`) não são
aceitas.

## Forma curta: `commands` e `on`

Comandos e listeners fixos vão direto no manifesto
([ADR 0079](../../../docs/adr/0079-acucar-no-manifesto-do-plugin.md)):

```ts
export const saldo = definePlugin({
  name: 'saldo',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({ moeda: z.string().default('R$') }),
  commands: {
    ping: { description: 'Responde pong', run: () => 'pong' },
    saldo: {
      description: 'Mostra seu saldo',
      run: async (c, { storage, config }) => {
        const valor = (await storage.kv.get(c.message.sender.id)) ?? 0;
        return `${config.moeda} ${valor}`;
      },
    },
  },
  on: {
    'group.joined': (e, { send }) => send.send(e.payload.chat.id, 'Oi, grupo!'),
  },
});
```

- **O nome vem da chave.** O resto é o mesmo `CommandDefinition` (`aliases`, `role`, `accepts`,
  `onReject`, `timeoutMs`...). `on` aceita um listener por evento, sem opções.
- **O 2º argumento é o contexto do plugin**, o mesmo do `setup`: `storage`, `config`, `send`,
  `log`, `services`... Com TypeScript, `config` sai tipado pelo schema. No `onReject`, ele vem no
  3º, depois da recusa, para o texto sair de `plugin.plugin.messages` e a config poder trocá-lo:
  `onReject: (_c, _rejection, plugin) => plugin.plugin.messages.uso`.
- **Devolver texto responde.** Um `run` que devolve string ou `fmt` responde citando a mensagem,
  como terminar com `await c.reply(texto)`. Isso vale para qualquer comando, também os do
  `setup`. Outro valor (`undefined`, a chave de um `c.reply(...)` devolvido) não responde nada.
- **`send.text` vem implícito.** Declarar `commands` já exige a capability `send.text`. O que
  depende de outra capability (mídia, reação) continua em `requires`, do plugin ou do comando.
- **Um caminho só.** O kernel registra os declarados com `ctx.commands.add` e `ctx.events.on`
  antes do `setup`, então prazo, recusa, teardown e reload são os da forma longa. O `setup` já
  os vê em `ctx.commands.list()`, e um conflito de nome derruba o boot como sempre.
- **O `setup` fica para o dinâmico:** registrar sob condição da config, vários listeners do mesmo
  evento, listener com `priority` ou filtro, papéis custom, rotas HTTP, serviços.

Como os comandos ficam no manifesto, dá para listá-los sem rodar o plugin (template, doc gerada,
menu nativo da plataforma).

### Em JavaScript

Nada aqui depende do TypeScript. Um plugin numa pasta de `pluginDirs` pode ser um objeto puro, sem
importar o core:

```js
// plugins/ping.mjs
export const ping = {
  name: 'ping',
  version: '1.0.0',
  engine: '<1.0.0',
  commands: {
    ping: { description: 'Responde pong', run: () => 'pong' },
  },
};
```

Sem o compilador, a validação é a rede: `definePlugin` (ou o boot, para o objeto puro) recusa
com `PluginManifestError` o comando sem `run`, o nome com espaço, o `name` repetido dentro do
comando, o `aliases` que não é lista e o evento com erro de digitação (`on: { mesage }`), um
problema por linha.

### Exportar com `isolatedDeclarations`

Pacote publicável anota o export: `export const ping: PluginDefinition = definePlugin({...})`.
A anotação larga aceita o plugin com config tipada (o `run` e os listeners do manifesto têm
parâmetro bivariante). Dentro do plugin a config segue tipada. Quem o recebe só o passa ao
`createBot` e não precisa do tipo estreito.

## Fontes: config e `pluginDirs`

O `Bot` faz isto no `start()` com `plugins` e `pluginDirs` da config. Por dentro (interno do kernel, não exportado ([ADR 0034](../../../docs/adr/0034-biblioteca-sem-runner.md))):

```ts
import { collectPlugins } from '#plugin/sources.ts';
import { sticker } from '@usebridger/plugin-media';

const plugins = await collectPlugins({
  plugins: [sticker],          // pacotes npm: o app importa e passa
  pluginDirs: ['./plugins'],   // relativo a `cwd` (padrão: process.cwd())
});
// → PluginEntry[]: { definition, origin } — origin é 'config' ou o caminho do módulo
```

As duas fontes dão a mesma `PluginDefinition`; a lista da config vem primeiro, depois cada
pasta na ordem dada. Convenção de pasta (`discoverPlugins(dir)`):

- cada arquivo `.ts`/`.mts`/`.js`/`.mjs` e cada subpasta com `index.*` é um módulo de plugin;
- todo export (nomeado) com `name` string e `setup` função (ou `commands`/`on` objeto) entra —
  um módulo pode exportar vários; o mesmo objeto exportado duas vezes conta uma;
- ficam de fora nomes começando com `_` ou `.`, `*.test.*`/`*.spec.*` e `.d.ts` — use `_` para
  helpers e pastas auxiliares;
- a ordem é a alfabética dos nomes, nunca a do sistema de arquivos;
- módulo sem plugin, subpasta sem `index.*`, pasta ilegível ou import que lança são
  `PluginDiscoveryError` (erro no boot, com o caminho e a causa).

`.ts` na pasta roda pelo type stripping do Node 24 — só sintaxe apagável.

## Subir e derrubar: `createPluginHost`

O `Bot` faz tudo isto no `start()`/`stop()` ([Bot → Plugins](bot.md#plugins)), com a fábrica de
contexto ligada aos serviços da instância. Por dentro (interno do kernel, não exportado ([ADR 0034](../../../docs/adr/0034-biblioteca-sem-runner.md))):

```ts
import { createPluginHost } from '#plugin/host.ts';

const host = createPluginHost({
  plugins,                                  // de collectPlugins
  transport,                                // { name, capabilities }
  disabledPlugins: ['sticker'],
  log,                                      // Logger
  createContext: (plugin) => ({             // quem monta o ctx é o Bot
    context: buildContext(plugin),
    dispose: () => removeEverythingFrom(plugin.name),
  }),
  setupTimeoutMs: 10_000,                   // padrão
  teardownTimeoutMs: 5000,                  // padrão
});

const table = await host.start();           // tabela de boot
// ...
const errors = await host.stop();           // PluginLifecycleError[]
```

### Boot (`start`)

1. **Erros de boot** — rejeitam `start()` antes de qualquer `setup`:
   `PluginManifestError` (manifesto malformado), `PluginConflictError` (dois plugins com o
   mesmo `name`, com as duas origens) e `PluginCycleError` (ciclo em
   `dependsOn`/`optionalDependsOn`/`after`, com o
   caminho: `a → b → c → a`, onde `→` = "depende de / carrega depois de").
2. **Ordem** (`sortPlugins`): toposort com `dependsOn`, `optionalDependsOn` e `after` como
   arestas; entre os
   prontos, `priority` maior primeiro e, no empate, a ordem de declaração. Nome citado que não
   existe não cria aresta. A ordenação considera todos os plugins, inclusive os desabilitados:
   ciclo é erro do código, não da config.
3. **Quem carrega**, na ordem, parando no primeiro motivo. O host confere isto para todos os
   plugins antes de qualquer `setup`; qualquer motivo que não seja `disabled` derruba o boot
   (passo 5) sem rodar nenhum `setup`:

   | Motivo (`reason.kind`) | Quando |
   | --- | --- |
   | `disabled` | nome em `disabledPlugins` (nome desconhecido ali gera `warn`) |
   | `engine` | `CORE_VERSION` fora da faixa `engine` |
   | `transport` | `transports` declarado e sem o nome do transport ativo |
   | `capabilities` | `requires` com capabilities que o transport não tem (lista todas) |
   | `dependency-missing` | `dependsOn` cita plugin que não existe |
   | `dependency-version` | a versão da dependência não satisfaz a faixa |
   | `dependency-skipped` | a dependência existe mas não carregou (inclusive `disabled`) — propaga em cadeia |
   | `setup-failed` | a fábrica de contexto ou o `setup` lançou ou estourou o prazo |

4. **Setup**: para cada compatível, `createContext(plugin)` e depois `setup(ctx)`, cada um com
   `setupTimeoutMs`. Se falhar, o loader chama `dispose()` (sem `teardown`, que só pareia com
   setup concluído), loga em `error` e marca o plugin — e quem depende dele — como ignorado. Os
   outros `setup`s rodam mesmo assim, para o erro listar todas as falhas de uma vez.
5. **Falha derruba o boot** ([ADR 0102](../../../docs/adr/0102-plugin-falho-derruba-o-boot.md)):
   se algum plugin ficou ignorado por motivo diferente de `disabled`, o host desce quem subiu
   (`teardown` + `dispose`, ordem inversa), fica em `stopped` e rejeita com `PluginBootError`. No
   `Bot`, o transport não conecta e `bot.start()` rejeita com o mesmo erro (o conflito de nome de
   comando, papel ou serviço sai com o próprio erro). O erro traz:

   | Campo | O quê |
   | --- | --- |
   | `failures` | as linhas ignoradas que derrubaram o boot, na ordem de carga |
   | `plugin`, `version`, `reason` | da primeira delas (a raiz: dependentes vêm depois) |
   | `cause` | em `setup-failed`, o `PluginLifecycleError` (com o erro original no `cause` dele) |

   A mensagem lista `nome@versão: motivo` de cada falha:

   ```
   1 plugin(s) não carregaram; boot abortado. enquete@1.0.0: capability ausente no transport:
   polls. Para subir sem um plugin de propósito, use disabledPlugins.
   ```

   Para subir sem um plugin (ex.: só existe em outro transport), liste-o em `disabledPlugins`,
   junto com quem depende dele por `dependsOn`. `reload`, `disable` e `enable` em runtime não
   derrubam o bot: o plugin que falha ali fica ignorado na tabela (ver abaixo).

A tabela volta de `start()` como dado (`PluginReportEntry[]`, na ordem de carga) e vai para o
log formatada — em `info` se tudo carregou, `warn` se algo foi ignorado ou se um plugin carregou
sem algum comando — com os mesmos dados em `fields.plugins`. Ela é logada quando os `setup`s
rodam, inclusive antes de um `PluginBootError` por `setup` falho; no boot que sobe, o único
ignorado possível é o `disabled`:

```
Plugins: 3 carregado(s), 1 ignorado(s)
  user-names  1.0.0  carregado
  sticker     1.2.0  carregado
  media       1.0.0  carregado; sem figurinha (send.sticker)
  enquete     1.0.0  ignorado (desabilitado em disabledPlugins)
```

`carregado; sem ...` lista os comandos com `requires` que o transport não sustenta e as
capabilities que faltam, e os com `services` que ninguém provia (`sem ds (serviço figurinhas)`):
o plugin subiu, mas eles não respondem ([Capability por comando](commands.md#capability-por-comando),
[Serviço por comando](commands.md#serviço-por-comando)). Na entrada, ficam em `unregistered`.

Ainda na entrada, quando há algo a dizer: `dependsOn` (o do manifesto, nome → faixa; também nas
linhas ignoradas), e nas carregadas `services` (nomes providos no `setup`) e `contributions`
(pontos de extensão a que o plugin contribuiu), lidos do registry na hora em que a tabela é montada, então um `provide` posterior ao `setup` também aparece (ADR 0112).

`host.report()` devolve a tabela atual (reflete reloads).

### Parada (`stop`)

`teardown` e depois `dispose` de cada plugin carregado, na **ordem inversa** da carga, cada
um com `teardownTimeoutMs`. Falha ou timeout de um não impede os outros: `stop()` nunca
rejeita por plugin, devolve as falhas (`PluginLifecycleError` com `plugin`, `phase`,
`timedOut` e `cause`) e as loga. É idempotente e espera um `start`/`reload` em andamento.

`stop(signal)` aceita um `AbortSignal`: abortado, o `teardown` em curso é abandonado e os
seguintes não rodam (cada um vira falha com `timedOut: true`), mas o `dispose` de todos roda.
É o que o `Bot` usa quando o prazo de parada acaba.

### Recarregar um plugin (`reload`)

```ts
const { plugin, dependents, teardownErrors } = await host.reload('ai');
```

O resultado (`PluginChangeResult`) é o mesmo para `reload`, `disable` e `enable`:

| Campo | O que é |
|-------|---------|
| `plugin` | Linha nova do plugin na tabela |
| `dependents` | Linhas novas dos dependentes descidos e subidos junto, na ordem de carga |
| `teardownErrors` | Falhas de `teardown`/`dispose` das instâncias que desceram, do plugin e dos dependentes. Falha do `setup` novo fica no `reason` da linha (`setup-failed`) |

`teardown` → `dispose` → contexto novo → `setup`. É a primitiva do reload por mudança de config
([ADR 0017](../../../docs/adr/0017-config-por-plugin-zod.md)): a fábrica lê a config já
atualizada. Vale para plugin carregado ou cujo `setup` falhou (para tentar de novo); os ignorados
por incompatibilidade recusam com `PluginHostStateError`. Não há reload de **código**
([ADR 0008](../../../docs/adr/0008-sem-hot-reload.md)).

**Em cascata** ([ADR 0041](../../../docs/adr/0041-reload-em-cascata.md)): quem depende do plugin
por `dependsOn`, direta ou transitivamente, recarrega junto, para não ficar com um serviço do
contexto descartado. Com `resumo` dependendo de `ai` e `digest` de `resumo`:

```text
teardown digest → teardown resumo → teardown ai → setup ai → setup resumo → setup digest
```

O plugin e os dependentes são reavaliados como no boot (desligado, ou com a dependência
desligada, ele não sobe). Se o `setup` novo do plugin falhar, os dependentes ficam
`dependency-skipped`; um reload seguinte que o suba traz todos de volta. Um dependente ignorado
por motivo próprio (ex.: desabilitado) continua ignorado. `after` não entra na cascata, porque só
ordena a carga. `optionalDependsOn` entra: o dependente opcional desce e sobe junto, e sobe mesmo
que o plugin não suba ([ADR 0099](../../../docs/adr/0099-comando-que-exige-servico.md)). O mesmo
vale para `disable` e `enable`.

### Desligar e ligar (`disable` / `enable`)

```ts
await bot.plugins.disable('ai');  // desce ai e os dependentes; ai vira "disabled"
await bot.plugins.enable('ai');   // sobe ai de volta e os dependentes que ele libera
```

Mesma cascata do `reload`, sem mexer na config: nada é gravado no storage. Desligado, o plugin
não carrega até `enable`, nem pelo `reload`, e o boot aceita a mesma lista em `disabledPlugins`
(o `enable` liga também quem veio dela).
Desligar um plugin já desligado, ou ligar um já ligado, não faz nada. Chamados antes do `start()`,
recusam com `BotStateError`. Os métodos ficam em `bot.plugins`; `bot.plugins()` segue devolvendo a
tabela de boot.

### A fábrica de contexto

O loader não conhece comandos, eventos, storage nem serviços: recebe
`createContext(plugin) => { context, dispose }`. `dispose` precisa desfazer tudo o que o plugin
registrou pelo contexto. Um `setup` que estoura o prazo continua rodando em segundo plano
(não há como abortar código síncrono/arbitrário); a fábrica deve fazer o contexto recusar
registros depois do `dispose`, para o setup atrasado não deixar nada para trás — a do `Bot` lança
`PluginHostStateError` em `commands.add`, `events.on`, `services.provide`, `services.contribute`, `scheduler.on`,
`http.route` e `http.ws` (o `dispose` tira as rotas e fecha os WebSockets delas), e
rejeita com `ContextExpiredError` `send` (com as ações), `groups`, `storage` (KV e coleções) e
`scheduler.at`/`cancel`.

`dispose(reason?)` recebe a falha do `setup` quando ele falhou ou estourou o prazo; a do `Bot` a
usa como `reason` do `ctx.signal`, que aborta no `dispose`.

### Cancelamento cooperativo para autores de plugin

O código do plugin não é interrompido à força: o kernel avisa pelo `signal` e recusa o que o
contexto expirado tentar fazer ([ADR 0033](../../../docs/adr/0033-cancelamento-cooperativo.md),
detalhes em [Bot](bot.md#prazos-e-cancelamento-ctxsignal)).

- `ctx.signal` (no `setup`) aborta quando o contexto é descartado: repasse ao trabalho de fundo
  do plugin (timers, conexões, streams) e pare-o no `abort`.
- `c.signal` (comando), `e.signal` (listener) e `{ signal }` (job) abortam no prazo da execução
  ou no descarte do plugin, o que vier antes: repasse a `fetch`/SDKs e confira `signal.aborted`
  antes de efeitos.
- Depois do prazo, o `reply` daquele contexto rejeita com `ContextExpiredError`; depois do
  descarte, o `reply` de toda execução do plugin e `send`/`groups`/`storage`/`scheduler.at`
  também. O atalho `react` segue a mesma regra do `reply`.
- Código síncrono travado (laço, CPU pesada) bloqueia o processo inteiro: nenhum prazo resolve.

## Agir no canal: ações e leituras

Tudo o que o transport sabe fazer chega ao plugin pela API pública, sem `ctx.unsafe.native`
([ADR 0040](../../../docs/adr/0040-acoes-do-transport-no-plugin.md)):

```ts
setup(ctx) {
  ctx.commands.add(command({
    name: 'todos',
    role: 'group-admin',
    run: async (c) => {
      // Ausente onde a plataforma não lista membros (Telegram, Discord grande).
      const { participants } = await ctx.groups.metadata(c.message.chat.id);
      if (!participants) return c.reply('Aqui não dá para listar os membros.');
      await c.reply('@todos', { mentions: participants.map((p) => p.id) });
      await c.react('📣'); // reage à mensagem do comando
    },
  }));
}
```

| No contexto | O que faz | Capability | Pela fila |
| --- | --- | --- | --- |
| `ctx.send.send(chatId, content)` | envia; `content` pode ser só o texto, cru ou [formatado](text.md) | `send.<tipo>` | sim |
| `ctx.send.react(key, emoji)` | reage; `null` remove | `reactions` | sim |
| `ctx.send.edit(key, text)` | troca o texto (cru ou formatado; não divide) | `message.edit` | sim |
| `ctx.send.delete(key)` | apaga para todos | `message.delete` | sim |
| `ctx.send.typing(chatId, kind)` | "digitando" (`text`) ou "gravando áudio" (`voice`) | `typing` | sim |
| `ctx.groups.metadata(groupId)` | nome (`title`), descrição, participantes (se a plataforma lista) | `groups` | não (leitura) |
| `ctx.groups.updateParticipants(groupId, ids, action)` | add, remove, promote, demote | `groups.add`, `groups.remove` ou `groups.promote` (também para `demote`) | sim |
| `ctx.commands.list()` | comandos de todos os plugins (`plugin`, `name`, `aliases`, `description`, `role`) | — | — |
| `ctx.commands.list({ for: message })` | só os que o remetente passa no papel ([commands.md](commands.md#comandos-que-o-remetente-pode-rodar)); `Promise` | — | — |
| `ctx.self` | contato da sessão; `null` até a primeira conexão | — | — |
| `ctx.session` | nome da sessão do bot (`default` se a config não define) | — | — |
| `ctx.connectionStatus()` | último `ConnectionStatus` do transport, `undefined` antes do primeiro evento ([ADR 0110](../../../docs/adr/0110-sessao-e-status-de-conexao-no-contexto.md)) | — | — |
| `ctx.transportName` | `name` do transport (`baileys`, `web`...), para compor chaves de ID no [`ctx.storage.shared`](storage.md#dados-comuns-a-vários-bots) | — | — |
| `ctx.capabilities` | `ReadonlySet` do que o transport suporta | — | — |
| `ctx.http.route(method, path, handler)` / `ctx.http.ws(path, accept)` | rota HTTP ou WebSocket sob `/plugins/<nome>` ([HTTP](http.md)) | — | — |

- As ações aceitam `{ priority }` (padrão `'normal'`). O atalho `c.react(emoji)`, no comando e nos
  listeners de mensagem, usa a chave da mensagem recebida e prioridade `'high'`, como o `reply`.
- A chave vem de `message.key`; para a mensagem citada, `message.quoted.key`. O `send` devolve a
  chave da mensagem criada, para editá-la ou apagá-la depois. Um texto longo que a fila dividiu
  devolve a chave da primeira parte ([Texto formatado](text.md#texto-longo)).
- Sem a capability, a ação rejeita na hora com `UnsupportedError`. Para recurso opcional,
  confira antes: `if (ctx.capabilities.has('message.edit')) await ctx.send.edit(key, 'ok')`.
  Para recurso obrigatório, declare em `requires`: no plugin, ou no comando que depende dele.
- A exceção é o atalho `c.react(emoji)`: reação no contexto quase sempre é enfeite (⏳ ✅ ❌), então
  sem `reactions` ele resolve sem reagir e registra em `debug`. Quem precisa saber que a reação
  não saiu usa `ctx.send.react(c.message.key, emoji)`, que rejeita com `UnsupportedError`
  ([ADR 0093](../../../docs/adr/0093-react-do-contexto-tolerante.md)).
- O kernel não restringe `edit`/`delete` às mensagens do bot: o transport decide o que o canal
  permite.
- `ctx.groups.metadata` não tem cache nem prazo próprio: o prazo da execução (comando, listener,
  job) limita quem espera.

## Acesso admin

`ctx.admin` é `{ plugins, config }`: delega às instâncias de `bot.plugins` (tabela de boot,
`reload`/`disable`/`enable`) e `bot.config` (`describe`, `jsonSchema`, `setOverrides`). Só os
plugins listados em `createBot({ adminPlugins: ['dashboard'] })` o recebem; os demais veem
`undefined`. A lista fica no app, e não no manifesto, para o plugin não se autoconceder o poder
([ADR 0111](../../../docs/adr/0111-acesso-admin-para-plugins.md)). Nome em `adminPlugins` que
não existe gera `warn` no boot.

Sobre o **próprio** plugin, `admin.plugins.reload`, `admin.plugins.disable` e
`admin.config.setOverrides` (que recarrega) rejeitam com `PluginHostStateError`: o plugin
desceria no meio da própria chamada. A outra diferença: `reload`/`disable`/`enable` e
`setOverrides` rejeitam com `ContextExpiredError` depois do `dispose` do plugin (ADR 0033); as
leituras ficam livres. No mais, o comportamento é o de `bot.plugins` e `bot.config`.

Tudo o que sai pelo `ctx.admin` passa pela máscara de segredos do bot (os mesmos valores que o
logger censura, trocados por `[REDACTED]`): a tabela de `plugins()`, o `PluginChangeResult`
(`reason.error`, `dependents`, `teardownErrors`), o `describe`/`jsonSchema` e o erro rejeitado
(`message`, `stack`, `cause`, `issues`). Recebe-se uma cópia profunda: o `Error` mantém o
protótipo (`instanceof` vale; `Error.isError(copia)` dá `false`), `Map`/`Set` são recriados e
instância de outra classe vira objeto simples com as propriedades próprias. Chaves `Symbol` são
descartadas. `bot.plugins` e `bot.config` seguem crus.

Não dê `await` em ação de admin dentro do `setup`/`teardown` do próprio plugin: a fila do host
roda uma operação por vez, então o plugin trava até o prazo e cai como `setup-failed`. Use as
ações a partir de comandos, rotas e jobs.

## Versão do core

`CORE_VERSION` é a versão conferida contra `engine`. Não se edita à mão: o PR de versão sai de
`pnpm version-packages`, que roda o `changeset version` e depois `scripts/sync-version.ts`,
reescrevendo a constante com a versão nova do `package.json`. Um teste compara as duas.
`createPluginHost({ coreVersion })` sobrescreve só em testes.

### Qual `engine` declarar no 0.x

Pela regra do `^` no npm, o primeiro dígito diferente de zero é o que trava: `^1.2.0` aceita
até `<2.0.0`, mas `^0.2.0` só aceita `0.2.x` e `^0.0.3` só aceita exatamente `0.0.3`. O core
está em `0.0.0` até o primeiro release (que sai `0.1.0`, porque há changesets `minor`
pendentes), então um plugin com `engine: '^0.0.0'` deixa de carregar no primeiro bump.

- **Plugins do monorepo** declaram `engine: '>=0.1.0 <1.0.0'` enquanto o core estiver no 0.x.
  Eles sobem junto com o core e o CI os testa contra o core do mesmo commit, então a faixa só
  precisa barrar o salto para a 1.0; `^0.1.0` os quebraria a cada minor.
- **Plugins de fora** declaram `^0.M.0`, com o minor contra o qual foram testados: no 0.x um
  minor pode quebrar a API.
- Na 1.0, todos passam a `^1.0.0`.

### Qual faixa declarar no `dependsOn`

A mesma regra do `^` vale para a versão da dependência: `^0.0.0` aceita só `0.0.0`, e o
dependente deixa de carregar (`dependency-version`) no primeiro bump de patch dela, mesmo sem
mudança incompatível. O boot avisa em `warn` quando um `dependsOn` ou `optionalDependsOn` usa
`^0.0.z`.

- **Plugins do mesmo repositório**, que sobem juntos: `0.x` ou `>=0.0.0 <1.0.0` enquanto a
  dependência estiver no 0.x.
- **Dependência publicada à parte:** `^0.M.0`, com o minor contra o qual o plugin foi testado.
- Comece plugins em `0.1.0` (como o template do `create-bridger-plugin`), não em `0.0.0`.

## Testando o plugin

O [`@usebridger/testing`](../../testing/docs/README.md) sobe o plugin num bot real sobre um
transport falso: `createTestBot({ plugins })`, `bot.receive({ text })` e matchers como
`expect(bot.sent).toHaveReplied(...)`.
