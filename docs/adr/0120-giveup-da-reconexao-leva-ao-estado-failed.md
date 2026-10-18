# ADR 0120 — O giveUp da reconexão leva o bot ao estado `failed`

**Status:** Aceito (2026-10-18) · Ajusta **D36** ([ADR 0036](0036-escopo-de-sessao.md), `replaced`:
parar é o certo), **D45** ([ADR 0045](0045-queda-de-rede-nao-limpa-sessao.md)) e **D68**
([ADR 0068](0068-desconexao-fatal-e-transport-sem-pareamento.md))

## Contexto

Quando a reconexão desiste (`closed` com `reason: 'fatal'`, `auth-failed` sem pareamento,
`replaced`, ou sessão a parear sem `clearSession`), o `giveUp` chamava `bot.stop()`. O stop
derruba os plugins, inclusive o `dashboard`, e fecha o HTTP. O card "Erro fatal" da Visão geral,
que mostra a mensagem e o link "Abrir config", nunca aparecia: o admin não tinha onde ver o erro
nem corrigir a config (#194).

## Decisão

- `BotState` ganha `'failed'`. O `giveUp` (`fatal`, `auth-failed` sem pareamento, `replaced`,
  `clean-session` sem `clearSession`) leva `running → failed`: para o reconector, desconecta o
  transport, fecha as filas de entrada e saída e as esperas de conversa (para o TTL não apagar
  esperas persistidas sem `onExpire`, ADR 0097/0098) e para o scheduler (os jobs ficam no storage
  para o próximo boot). Plugins e HTTP seguem no ar.
- Se o giveUp chega durante o `start()` (erro fatal no connect inicial, o caso de token ou
  intents inválidos), o boot termina em `failed` sem iniciar o scheduler e o `start()` RESOLVE:
  o painel tem que ficar no ar para o admin ver o erro.
- Em `failed` nenhum handler ou comando é despachado (a fila de entrada está fechada) e os eventos
  `connection.status` do transport deixam de ser registrados e reemitidos. O último status (o do
  erro) fica guardado e é o que o painel mostra.
- `stop()` a partir de `failed` faz o shutdown normal (plugins, HTTP, sessão) e chega a `stopped`,
  esperando a desconexão do transport já iniciada, sem repeti-la.
- `start()` a partir de `failed` rejeita com `BotStateError`, como em `stopped`: a instância não
  reinicia; para subir de novo, crie outro `Bot`. É o mais simples e coerente com o estado
  terminal que já existe.
- O log do giveUp passa a dizer que o bot vai a `failed`, com plugins e HTTP no ar.

## Alternativas

- **Stop a cargo da aplicação** (o kernel só emite o evento): empurra para cada app o código que
  mantém o painel vivo e deixa o bot meio-parado sem estado nomeado. Rejeitada.
- **Manter o `stop()`**: o painel morre junto com o erro que ele existe para mostrar. Rejeitada.

## Consequências

- Quem esperava `bot.state === 'stopped'` ou o processo sair após erro fatal precisa tratar
  `failed` (chamar `bot.stop()` ou observar o estado). Um processo com HTTP aberto não termina
  sozinho.
- A trava da sessão (ADR 0074) continua sendo renovada em `failed`: nenhum outro processo assume a
  sessão até alguém chamar `stop()`. O `/health` responde 503 em `failed`.
- Os testes de `fatal-disconnect` e `reconnect` passam a esperar `failed`.
- `BotState` é API pública: novo valor na união (minor).
