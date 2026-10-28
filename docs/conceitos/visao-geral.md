# Visão geral

Esta página explica o que o Bridger é, o que fica no core e o que fica em plugin, quais
plataformas ele atende e o que esperar de estabilidade enquanto está na versão `0.x`.

## Um framework, não um bot pronto

O Bridger é o miolo que todo bot de mensageria reescreve: receber mensagens de uma plataforma,
pôr ordem nelas, decidir quem trata cada uma, guardar dados, agendar tarefas e enviar respostas
sem tomar ban. O comportamento do bot (os comandos, a IA, os lembretes) fica fora dele, em
**plugins**.

Ele nasceu de dentro do LumaBot, um bot de WhatsApp que já tinha plugins, mas com vazamentos que
obrigavam o autor a ler o código interno para escrever um. O core foi reescrito do zero com uma
meta explícita: **um terceiro escreve um plugin sem conhecer o funcionamento interno**. O contrato
público (tipos, documentação e kit de testes) é o produto, e o LumaBot passou a ser só mais um app
que o usa pelo npm.

## Framework sem runner: quem chama quem

O Bridger é um framework: core, transports, storages, kit de testes e plugins oficiais usados
juntos. A diferença para outros frameworks está em quem chama quem.

- **Sem runner.** Não há CLI de execução nem arquivo de config descoberto por convenção. Seu app
  importa `createBot`, passa as peças e chama `start()`. Você escolhe o processo, o supervisor e
  como a config chega.
- **Com inversão de controle** depois do `start()`. O plugin declara comandos, listeners e jobs, e
  **o core decide quando rodá-los**. O plugin não lê a fila nem chama o roteador.
- **Com core pequeno.** O core tem escopo fechado: só o que todo bot precisa e que não depende de
  uma plataforma.

```ts
import { createBot } from '@usebridger/core';
import { baileys } from '@usebridger/transport-baileys';

const bot = createBot({ transport: baileys(), plugins: [ping] });
await bot.start(); // só aqui algo conecta
```

Importar o core não tem efeito colateral: nada conecta, abre banco, lê variável de ambiente ou
cria timer até o `start()`. Todo estado fica pendurado na instância `Bot`, então dois bots no
mesmo processo não dividem nada por acidente.

A API pública se divide por público:

| Quem você é | O que usa | Importa de |
| --- | --- | --- |
| Autor do app | `createBot`, `createHttp`, `createLogger` | `@usebridger/core` |
| Autor de plugin | `definePlugin`, `command`, os contextos, os erros | `@usebridger/core` |
| Autor de transport ou storage | o contrato `Transport` e o `StoragePort` | `@usebridger/core/adapter` |

O resto (host de plugins, filas, scheduler) é interno e pode mudar sem aviso.

## O que é core e o que é plugin

O core contém, e só contém: conexão e reconexão, o contrato `Transport`, o modelo de mensagem,
as filas de entrada e de saída, middlewares, comandos, eventos, o ciclo de vida dos plugins,
storage, scheduler, logger, config, papéis, HTTP e API, auditoria e mídia. **Todo o resto é
plugin**: ajuda, ranking, IA, figurinhas, painel.

O escopo é fechado porque um core sem fronteira cresce por acúmulo: cada recurso entra "porque
todo bot precisa", e logo todo bot carrega o que não usa, com a API e os bugs junto. O teste
prático é: se um plugin consegue fazer pela API pública, é plugin. Se um plugin **não consegue**
por falta de API, a lacuna é do core, e se resolve no core.

Até o painel de administração é plugin. O `@usebridger/plugin-dashboard` é um app web que usa a
API HTTP do core como qualquer outro cliente (login, conexão e QR ao vivo, logs, plugins e config,
auditoria). Quem quiser outro painel, ou integrar com um sistema próprio, usa a mesma API
([Bot e sessão → HTTP](bot-e-sessao.md#http)). O outro plugin oficial é o
`@usebridger/plugin-metrics`, que reúne métricas e expõe o `GET /metrics`.

## Plataformas

O core não conhece nenhuma plataforma; ele conhece o contrato `Transport`. Cada transport traduz
a plataforma para um modelo neutro de mensagem, contato e chat, e declara **capabilities**, a
lista do que sabe fazer (reagir, editar, mandar figurinha, botões). Um plugin que usa só o
contrato roda em qualquer transport.

| Plataforma | Transport | Situação |
| --- | --- | --- |
| WhatsApp (pelo Baileys) | `@usebridger/transport-baileys` | disponível |
| Telegram (Bot API, pelo grammY) | `@usebridger/transport-telegram` | disponível; ainda sem álbum e enquete |
| Sistema web próprio (chat num ERP, num site) | `@usebridger/transport-web` | disponível |
| Discord | `transport-discord` | planejado para depois do 1.0 |
| WhatsApp Cloud API, Twilio, Zenvia | repositório privado | planejados, comerciais |

Escolher a plataforma é trocar uma linha:

```ts
import { baileys } from '@usebridger/transport-baileys';
import { telegram } from '@usebridger/transport-telegram';

createBot({ transport: baileys(), plugins });
createBot({ transport: telegram({ token }), prefix: '/', plugins }); // token do @BotFather
```

O 1.0 só sai depois que um plugin portátil rodar sem mudança nas plataformas principais. O
transport web foi o primeiro depois do WhatsApp de propósito: o dono controla as duas pontas, ele
roda no CI sem conta externa e força o contrato a sair do formato do WhatsApp (identidade por
token, tenant, botões, prefixo vazio). Os transports comerciais de WhatsApp e as integrações com
sistemas do dono vivem num repositório privado, sobre a mesma API pública. A matriz do que cada
transport suporta está em [Capabilities](../guias/capabilities.md#matriz-por-transport).

## Estabilidade antes do 1.0

O Bridger está em `0.x`. Pela regra do semver, isso permite mudança incompatível em qualquer
minor, e o projeto usa essa liberdade para acertar o contrato antes de congelá-lo. Três
mecanismos limitam o estrago:

- **`engine` obrigatório no manifesto.** Todo plugin declara a faixa semver do core com que foi
  testado. Se a faixa não aceita a versão instalada do core, o boot para antes de conectar e diz
  qual plugin e por quê, em vez de o plugin quebrar no meio de uma conversa. No `0.x` o template
  usa `<1.0.0`.
- **Changelog por pacote**, gerado pelos changesets, que marca o que é incompatível.
- **Uniões fechadas, adição como minor.** Tipo de mensagem novo, capability nova ou campo
  opcional novo entram sem quebrar quem escreveu `default` no `switch`. Por isso, trate `unknown`
  e todo tipo que você não conhece, e não use o `never` exaustivo.

```ts
switch (message.type) {
  case 'text': /* ... */ break;
  default: break; // tipos novos chegam sem quebrar este código
}
```

Depois do 1.0, uma remoção só acontece depois de pelo menos um minor com `@deprecated`, e APIs
novas podem nascer `@experimental`.

## Quando não usar

- **Para uma chamada avulsa à plataforma.** Mandar uma mensagem de um script é menos código com a
  biblioteca da plataforma direto.
- **Se você precisa de Discord hoje.** O transport ainda não existe; escrever o seu é possível
  ([Contribuindo](contribuindo.md#escrever-um-transport)), mas é trabalho.
- **Para escalar uma sessão horizontalmente.** Uma sessão (um número) roda em um processo só. Dá
  para ter vários números num processo, não um número em vários processos
  ([Bot e sessão](bot-e-sessao.md#vários-bots-e-vários-processos)).
- **Para isolar plugins não confiáveis.** Plugins rodam no mesmo processo, sem sandbox: um erro
  não derruba o bot, mas código malicioso derruba. Instale só plugin cujo código você confia,
  como qualquer dependência npm.
- **Se você não quer escrever código.** Não há construtor visual nem bot pronto.
