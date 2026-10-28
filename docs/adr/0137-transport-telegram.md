# ADR 0137 — Transport do Telegram sobre o grammY

**Status:** Aceito (2026-10-28) · Aplica o contrato multiplataforma dos ADRs
[0051](0051-plataformas-alvo-e-transport-web.md) a
[0069](0069-kit-de-testes-multiplataforma.md) ao Telegram (issue #26)

## Contexto

O ADR 0051 pôs o Telegram depois do v1.0, mas os ADRs 0052 a 0069 já moldaram o contrato pela
documentação da Bot API: 401 vira `auth-failed` e 409 vira `replaced` (ADR 0064), o `id` do botão
cabe nos 64 bytes do `callback_data` (ADR 0058), o tópico de fórum entra no `chat.id` (ADR 0054)
e a menção é um nó da árvore neutra (ADR 0057). Faltava o transport que confirma o contrato numa
plataforma real. A issue #26 deixou duas perguntas em aberto: a biblioteca e o modo de receber
updates.

Alternativas consideradas:

- **Bot API direto (`fetch`).** Sem dependência, mas o transport teria de escrever o laço de
  `getUpdates` com offset e retry, o upload multipart e os tipos da API, que mudam a cada versão.
- **telegraf.** Mais antiga e menos ativa, com tipos piores que os do grammY.
- **grammY com `@grammyjs/runner`.** O runner processa updates em paralelo. A fila de entrada do
  bot já ordena por chat (ADR 0038), então o paralelismo só somaria uma dependência.
- **Webhook como padrão.** Exige o HTTP do core (ADR 0072) e uma URL pública já no primeiro uso.
- **Uma PR com toda a matriz da §6.10.** O álbum agrupado na entrada, as enquetes com
  `poll_answer` e o webhook têm decisões próprias (janela do álbum, enquete não anônima, URL e
  segredo do webhook) e atrasariam o núcleo.

## Decisão

- **`@usebridger/transport-telegram`**, público (Apache-2.0, ADR 0051), sobre o **grammY**: tipos
  completos da Bot API, mantido e escrito em TypeScript. A fábrica é `telegram({ token })`. O
  token é validado na fábrica, e um formato inválido vira `BotConfigError` no `createBot`.
- **Long polling pelo `bot.start()` do grammY** é o modo padrão. Ele não exige URL pública nem a
  opção `http` no `createBot`. O grammY re-tenta sozinho as falhas transitórias do `getUpdates` e
  só para em 401 e 409. Por isso o transport emite `closed` só quando a queda é terminal, como o
  ADR 0064 prevê para quem se reconecta sozinho. O webhook, por `TransportDeps.http`, fica como
  opção para depois (#310).
- **Mapeamento da queda:** 401 → `auth-failed`, 409 → `replaced`, qualquer outra rejeição do
  `start()` (rede no `getMe` do boot) → `connection-lost`. O `start()` apaga o webhook antes de
  começar, então o 409 que chega é sempre de outro `getUpdates`.
- **Escopo da primeira versão:** texto e mídias (foto, vídeo, áudio, voz, figurinha, documento),
  legenda, citação, menções, botões com `callback_query`, menu de comandos (`setMyCommands`),
  "digitando", reações, edição, apagamento, download e referência de mídia (`file_id`), grupos
  com consulta de admin, remoção e promoção de participantes, e tópicos de fórum no `chat.id`. O
  álbum (envio e agrupamento na entrada, #308), as enquetes (#309) e o webhook (#310) ficam para
  issues próprias. O
  transport não declara `send.album` nem `polls` até lá.
- **Texto cru vai sem `parse_mode`.** A Bot API devolve 400 numa marcação mal escapada, e um `<`
  ou `_` solto num texto comum derrubaria o envio. Quem quer formatação usa a árvore neutra, que o
  transport renderiza em HTML com escape. A menção da árvore vira um link `tg://user?id=`, que
  notifica sem precisar de `@usuario`.
- **Resposta a clique é mensagem nova.** O ID da interação leva o prefixo `cb:`. O envio que
  cita uma interação não manda `reply_parameters`, porque o `callback_query.id` não é ID de
  mensagem. O transport confirma o clique (`answerCallbackQuery`) antes de emitir, sem esperar a
  resposta para seguir o polling.
- **Menu de comandos:** os comandos `everyone` vão no escopo padrão. Os comandos `group-admin`
  vão, junto com os `everyone`, no escopo `all_chat_administrators`. O que o Telegram não aceita
  (nome fora de `[a-z0-9_]{1,32}`) fica fora do menu, com log em `debug`. A lista só vai à API
  quando muda.
- **Participantes pelo `chat_member`**, que dá o autor e a promoção, em vez das mensagens de
  serviço (`new_chat_members`). O Telegram só manda o `chat_member` a bot admin. As mensagens de
  serviço não viram `message`.
- **Ritmo e limites:** `pacing` de 34 ms global (30 mensagens/s) e 1000 ms por chat; `limits` de
  4096 de texto e 1024 de legenda.

## Consequências

- O `grammy` entra como dependência do pacote. O core continua sem nada da plataforma.
- **Privacy mode:** em grupo, o bot só recebe comandos, menções e respostas a ele. Um plugin que
  lê toda mensagem do grupo precisa do privacy mode desligado no BotFather ou do bot como admin.
  A doc do pacote registra isso.
- A Bot API não avisa quando uma mensagem é apagada: o transport nunca emite `message.deleted`.
  Uma menção `@usuario` sem conta vinculada não traz ID: só a menção ao próprio bot entra em
  `mentions`.
- O perfil `telegram` do kit de testes (ADR 0069) continua com `send.album` e `polls`, que é o
  alvo. O transport passa a declará-los quando as issues de álbum e enquete fecharem.
- Depois de um `stop()` durante uma falha de rede, o `sleep` de 3 s do `handlePollingError` do
  grammY ainda termina sozinho. Ele não emite nada, porque a tentativa já foi invalidada.
