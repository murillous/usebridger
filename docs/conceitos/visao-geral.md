# Visão geral

## Um kernel, não um bot pronto

O Bridger é o miolo que todo bot de mensageria reescreve: receber mensagens de uma plataforma,
pôr ordem nelas, decidir quem trata cada uma, guardar dados, agendar tarefas e enviar respostas
sem tomar ban. O comportamento do bot (os comandos, a IA, os lembretes) fica fora dele, em
plugins.

Ele nasceu de dentro do LumaBot, um bot de WhatsApp que já tinha plugins, mas com vazamentos que
obrigavam o autor a ler o código interno para escrever um. Em vez de refatorar no lugar, o kernel
foi reescrito do zero com uma meta explícita: **um terceiro escreve um plugin sem conhecer o
funcionamento interno**. O contrato público (tipos, documentação e kit de testes) é o produto; o
LumaBot virou o primeiro app a consumi-lo pelo npm
([ADR 0080](../adr/0080-repositorios-separados.md), [ADR 0082](../adr/0082-plugins-da-luma-no-lumabot.md)).

## SDK, framework ou kernel? Quem chama quem

As três palavras servem em parte, e a diferença está em quem chama quem.

- **Como uma biblioteca (SDK)**, o Bridger não tem runner, CLI de execução nem arquivo de config
  descoberto por convenção. Seu app importa `createBot`, passa as peças e chama `start()`. Você
  escolhe o processo, o supervisor e como a config chega
  ([ADR 0030](../adr/0030-biblioteca-sem-runner.md)).
- **Como um framework**, há inversão de controle depois do `start()`: o plugin declara comandos,
  listeners e jobs, e **o kernel decide quando rodá-los**. O plugin não lê a fila nem chama o
  roteador.
- **Kernel** é o nome que fica, porque o escopo é fechado: só o que todo bot precisa e que não
  depende de uma plataforma.

Importar o core não tem efeito colateral: nada conecta, abre banco, lê variável de ambiente ou
cria timer até o `start()`. Todo estado fica pendurado na instância `Bot`, então dois bots no
mesmo processo não dividem nada por acidente ([ADR 0003](../adr/0003-uma-sessao-por-processo.md)).

A API pública também se divide por público. `@usebridger/core` é o que o autor de plugin usa
(`definePlugin`, `command`, os contextos, os erros) mais o pouco que o app usa para compor
(`createBot`, `createHttp`, `createLogger`). `@usebridger/core/adapter` é para quem escreve
transport ou storage. O resto (host de plugins, filas, scheduler) é interno e pode mudar sem
aviso.

## O que é core e o que é plugin

O core contém, e só contém: conexão e reconexão, o contrato `Transport`, o modelo de mensagem,
as filas de entrada e de saída, middlewares, comandos, eventos, o ciclo de vida dos plugins,
storage, scheduler, logger, config, papéis, HTTP e mídia. **Todo o resto é plugin**: ajuda,
ranking, IA, figurinhas, painel ([ADR 0011](../adr/0011-escopo-do-core.md)).

O escopo é fechado porque um kernel sem fronteira cresce por acúmulo: cada recurso entra "porque
todo bot precisa", e logo todo bot carrega o que não usa, com a API e os bugs junto. Com a
fronteira escrita, entrar algo novo no core exige um ADR que explique por que aquilo não cabe num
plugin. O teste prático é: se um plugin consegue fazer pela API pública, é plugin. Se um plugin
**não consegue** por falta de API, a lacuna é do core, e se resolve no core
([ADR 0026](../adr/0026-open-core-repo-privado.md)).

Até o painel de administração é plugin: ele lê o barramento de eventos e os schemas de config e
se expõe pelo HTTP do core ([ADR 0019](../adr/0019-dashboard-vira-plugin.md)).

## Plataformas

O core não conhece nenhuma plataforma; ele conhece o contrato `Transport`. Cada transport traduz
a plataforma para um modelo neutro de mensagem, contato e chat, e declara **capabilities**, a
lista do que sabe fazer (reagir, editar, mandar figurinha, botões). Um plugin que usa só o
contrato roda em qualquer transport
([ADR 0002](../adr/0002-transport-abstrato.md), [ADR 0008](../adr/0008-capabilities-do-transporte.md)).

| Plataforma | Transport | Situação |
| --- | --- | --- |
| WhatsApp (pelo Baileys) | `@usebridger/transport-baileys` | disponível |
| Sistema web próprio (chat num ERP, num site) | `@usebridger/transport-web` | disponível |
| Telegram e Discord | `transport-telegram`, `transport-discord` | planejados para depois do 1.0 |
| WhatsApp Cloud API, Twilio, Zenvia | repositório privado | planejados, comerciais |

O web veio antes do Telegram e do Discord de propósito: o dono controla as duas pontas, ele roda
no CI sem conta externa e força o contrato a sair do formato do WhatsApp (identidade por token,
tenant, botões, prefixo vazio). O 1.0 só sai depois que um plugin portátil rodar sem mudança no
Baileys e no web ([ADR 0051](../adr/0051-plataformas-alvo-e-transport-web.md)). Os transports de
Telegram e Discord são públicos, como o kernel; os de WhatsApp comerciais e as integrações com
sistemas do dono vivem num repositório privado, sobre a mesma API pública.

## Estabilidade antes do 1.0

O Bridger está em `0.x`. Pela regra do semver, isso permite mudança incompatível em qualquer
minor, e o projeto usa essa liberdade para acertar o contrato antes de congelá-lo
([ADR 0024](../adr/0024-releases-changesets.md)). Três mecanismos limitam o estrago:

- **`engine` obrigatório no manifesto.** Todo plugin declara a faixa semver do core com que foi
  testado. Se a faixa não aceita a versão instalada do core, o boot para antes de conectar e diz
  qual plugin e por quê, em vez de o plugin quebrar no meio de uma conversa
  ([ADR 0014](../adr/0014-manifesto-do-plugin.md), [ADR 0098](../adr/0098-plugin-falho-derruba-o-boot.md)). No `0.x` o template usa `<1.0.0`.
- **Changelog por pacote**, gerado pelos changesets, que marca o que é incompatível.
- **Uniões fechadas, adição como minor.** Tipo de mensagem novo, capability nova ou campo
  opcional novo entram sem quebrar quem escreveu `default` no `switch`. Por isso a regra para o
  autor é tratar `unknown` e todo tipo que ele não conhece, nunca com o `never` exaustivo
  ([ADR 0065](../adr/0065-unioes-de-tipo-antes-do-1-0.md)).

Depois do 1.0, uma remoção só acontece depois de pelo menos um minor com `@deprecated`, e APIs
novas podem nascer `@experimental`.

## Quando não usar

- **Para uma chamada avulsa à plataforma.** Mandar uma mensagem de um script é menos código com a
  biblioteca da plataforma direto.
- **Se você precisa de Telegram ou Discord hoje.** Os transports ainda não existem; escrever o
  seu é possível ([Contribuindo](contribuindo.md#escrever-um-transport)), mas é trabalho.
- **Para escalar uma sessão horizontalmente.** Uma sessão (um número) roda em um processo só. Dá
  para ter vários números num processo, não um número em vários processos
  ([Bot e sessão](bot-e-sessao.md#vários-bots-e-vários-processos)).
- **Para isolar plugins não confiáveis.** Plugins rodam no mesmo processo, sem sandbox
  ([ADR 0004](../adr/0004-plugins-no-mesmo-processo.md)). Instale só plugin cujo código você
  confia, como qualquer dependência npm.
- **Se você não quer escrever código.** Não há construtor visual nem bot pronto.
