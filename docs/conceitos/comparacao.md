# Comparação com outros projetos

O Bridger ocupa uma camada específica: acima da biblioteca que fala com a plataforma e abaixo do
bot pronto. Os projetos abaixo são os mais próximos, cada um numa camada ou num ecossistema
diferente. A comparação é sobre o desenho, não um ranking: em vários casos a escolha certa é o
outro projeto.

## Resumo

| Projeto | Linguagem | Camada | Plataformas |
| --- | --- | --- | --- |
| **Bridger** | TypeScript | kernel com plugins | WhatsApp (Baileys) e web; Telegram e Discord planejados |
| Baileys | TypeScript | biblioteca de protocolo | WhatsApp |
| whatsapp-web.js | JavaScript | cliente sobre navegador | WhatsApp |
| BuilderBot | TypeScript/JavaScript | framework de fluxos | WhatsApp e outras, por provider |
| Koishi | TypeScript | framework de bot com plugins | várias, por adapter |
| NoneBot2 | Python | framework de bot com plugins | várias, por adapter |
| Chat SDK | TypeScript | SDK de bot multiplataforma | plataformas de trabalho e mensageria, por adapter |

## Baileys

O Baileys fala o protocolo do WhatsApp Web (multi-device) por WebSocket, sem navegador. Ele
entrega o socket e os eventos crus da plataforma; fila, comandos, reconexão, persistência das
credenciais e ritmo de envio ficam por conta de quem usa.

O Bridger **usa** o Baileys: o `@usebridger/transport-baileys` é um adapter sobre ele. A
diferença é de camada. Com o Baileys puro, o código do bot conhece `WAMessage`, JIDs e os
envelopes de mensagem temporária; com o Bridger, o plugin vê uma `Message` neutra e o transport
desembrulha o resto. Quando o plugin precisa de algo só do Baileys, o escape hatch dá o socket
([Plugins → escape hatch](plugins.md#escape-hatch-e-o-preço-dele)).

Use o Baileys direto para um script ou uma integração pontual. Use o Bridger quando o bot tem
vários comandos, autores ou plataformas.

## whatsapp-web.js

O whatsapp-web.js controla o WhatsApp Web num Chromium sem interface (Puppeteer). Por rodar o
cliente oficial, acompanha bem a interface, ao custo de um navegador por sessão (memória e
dependências do sistema). Como o Baileys, é um cliente da plataforma, não um framework de bot.

No Bridger, o lugar dele seria um transport. Não há um oficial: o projeto escolheu o Baileys pelo
custo de rodar sem navegador.

## BuilderBot

O BuilderBot é o mais parecido no público (bots de WhatsApp em JavaScript) e o mais diferente no
modelo. Ele é orientado a **fluxos**: palavras-chave disparam uma sequência de respostas
encadeadas (`addKeyword`, `addAnswer`), e o bot inteiro é a soma dos fluxos. Providers trocam a
plataforma (Baileys, a API oficial da Meta, Twilio e outros) e adapters trocam o banco.

O Bridger é orientado a **plugins**: cada plugin é um pacote com nome, versão, faixa do core,
capabilities exigidas, config validada e testes próprios, e plugins de autores diferentes
convivem no mesmo bot. A conversa de vários passos existe
([O caminho da mensagem → conversa](mensagem.md#conversa-de-vários-passos)), mas é um recurso
entre outros, não o modelo. Também ficam no kernel coisas que num framework de fluxos ficam com
o app: fila de saída com ritmo anti-ban, trava de sessão entre processos, isolamento por tenant.

Se o bot é um funil de atendimento escrito por uma pessoa, o modelo de fluxos é mais direto. Se
ele é um produto com vários módulos, autores e plataformas, o modelo de plugins escala melhor.

## Koishi

O Koishi é o parente arquitetural mais próximo: TypeScript, multiplataforma por adapters, tudo
como plugin, services entre plugins, config por schema e um console web. Nasceu no ecossistema
chinês (QQ e OneBot) e tem um mercado de plugins grande.

As diferenças são de escolha:

- **Biblioteca, não runner.** O Koishi tem app e console próprios; o Bridger não tem processo
  próprio, o app compõe o bot ([Visão geral](visao-geral.md#sdk-framework-ou-kernel-quem-chama-quem)).
- **Capabilities declaradas.** O plugin do Bridger diz em `requires` o que precisa, e o boot
  recusa o incompatível antes de conectar
  ([Plugins → requires](plugins.md#exigir-uma-capability-ou-conferir)).
- **Foco em WhatsApp e sistemas web**, com fila anti-ban e pareamento no kernel.
- **Sem hot-reload de código.** O Koishi recarrega plugins; o Bridger recarrega só config e
  reinicia o processo para código novo ([ADR 0008](../adr/0008-sem-hot-reload.md)).

## NoneBot2

O NoneBot2 é um framework Python (asyncio) com adapters por plataforma e plugins, com injeção de
dependências nos handlers e matchers que decidem quem trata cada evento. O papel é o mesmo do
Bridger; a escolha costuma ser pela linguagem e pelo ecossistema. O roteamento do Bridger é mais
fechado: um comando consome a mensagem, os listeners recebem o resto em paralelo, e uma conversa
pendente vem antes dos dois ([ADR 0012](../adr/0012-pipeline-de-3-estagios.md)).

## Chat SDK

O Chat SDK, da Vercel, é um SDK TypeScript para bots em várias plataformas (Slack, Microsoft
Teams, Google Chat, Discord, Telegram, GitHub, Linear e WhatsApp pela API oficial), com um
adapter por plataforma e o estado num adapter à parte (Redis, Postgres ou memória). Ele mira bots
de trabalho e agentes de IA servidos por webhook.

Ele e o Bridger dividem a ideia central: um modelo neutro por cima de adapters. O Bridger difere
em três pontos:

- **Plugins de terceiros como unidade.** Manifesto com faixa do core, capabilities, dependências,
  config e reload, e um kit de testes por perfil de plataforma.
- **Processo de longa duração.** O Bridger segura conexões persistentes (o socket do WhatsApp),
  com fila de saída, scheduler e trava de sessão; não é feito para função serverless.
- **WhatsApp não oficial e sistemas web próprios** como alvo principal.

## Onde o Bridger se encaixa

Escolha o Bridger quando o bot é um processo que fica no ar, fala com WhatsApp ou com o chat do
seu sistema, e o comportamento vem de vários plugins que precisam ser escritos, testados e
versionados à parte, sem que o autor conheça o kernel.
