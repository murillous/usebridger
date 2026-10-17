# ADR 0109 — Sinal `log` nos observadores

**Status:** Aceito (2026-10-17) · Detalha **D106** ([ADR 0106](0106-observadores-do-core.md)) ·
Usado pelo dashboard (**D21**, [ADR 0021](0021-dashboard-vira-plugin.md); **D107**, **D108**)

## Contexto

O dashboard precisa mostrar as linhas de log do bot, e o ADR 0021 pede que elas cheguem "via
barramento". O barramento aguarda o listener e seguraria o chat a cada linha de log; o
`diagnostics_channel` é global ao processo (ADR 0106). Os observadores já resolvem esse problema
para métricas: síncronos, nunca aguardados, por `Bot`.

Alternativas consideradas:

- **Evento `log` no barramento.** Listener aguardado em caminho que loga o tempo todo, e um log
  dentro do listener reentra no próprio evento.
- **`LogDestination` do app.** Só vale quando o app usa `createLogger`; com `config.logger`
  próprio o plugin não vê nada, e a mascaração de secrets ficaria a cargo do app.

## Decisão

- **Sinal `log`** em `ObserverSignals`: `LogSignal { level: Exclude<LogLevel, 'silent'>;
  time: number; message: string; fields: LogFields }`. `time` é `Date.now()`; `fields` junta os
  campos da chamada e os bindings dos loggers filhos (`plugin`, `chatId`, `transport`).
- **Envolve o `Logger` raiz do bot** (`logger/signal.ts`), não o destino do pino: cobre core,
  transport e plugins, e também o `config.logger` do app. Só sai a linha que passa do nível do
  logger, lido a cada linha.
- **Secrets mascarados** no sinal com o mesmo `SecretSet` do log (`[REDACTED]` em `message` e em
  todo valor string de `fields`; `Error` vira `{ type, message, stack, cause }`).
- **Reentrada:** enquanto um observador de `log` roda, o que se loga não gera sinal, inclusive o
  `plugin.error` do próprio observador que falha (o reporte também roda nesse modo).
- Erro do observador segue o ADR 0106: `plugin.error` com `phase: 'observer'`.
- Sem observador de `log`, a linha só é repassada ao logger: o sinal não é montado.

## Consequências

- Sinal novo é minor. Mudar ou remover campo é major.
- Cada linha emitida com observador paga a cópia dos `fields`; o custo é do plugin que assina.
- Linhas feitas dentro de um observador de `log` ficam fora do sinal, por desenho.
- Uma linha logada antes do `start()` (logger no-op) não existe, então também não vira sinal.
