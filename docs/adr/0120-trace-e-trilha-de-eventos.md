# ADR 0120 — Trace de correlação e trilha de eventos por unidade de trabalho

**Status:** Aceito (2026-10-24) · Complementa o [ADR 0118](0118-contrato-de-log-estruturado.md)
(o campo `trace` do dicionário), o [ADR 0105](0105-sinal-de-log-nos-observadores.md) (sinal `log`) e
o [ADR 0119](0119-pseudonimo-estavel-nos-logs.md) (`chat` e `sender` pseudonimizados)

## Contexto

Para estudar o que o usuário fez antes de um bug, é preciso juntar tudo o que uma mensagem causou:
o roteamento, o comando, o que o plugin logou, os envios e os jobs agendados (#232). Faltavam duas
coisas:

- **Trilha.** Uma mensagem tratada com sucesso não deixava linha nenhuma. O `message.handled` e o
  `outbound.sent` existiam só como sinais dos observadores (ADR 0102), para métricas.
- **Correlação.** O log do plugin, o envio (na fila de saída, em outro momento) e o job agendado
  não tinham um id em comum.

## Decisão

### O `trace`

- **Formato:** 32 hex minúsculos, o `trace-id` do W3C Trace Context, gerado no core
  (`randomUUID` sem hífens). Um Tempo ou OTel pode vir depois sem trocar o id.
- **Escopo:** um `AsyncLocalStorage` com o `trace` corrente (`trace/scope.ts`), como o do
  `TenantScope` (ADR 0068), mas **do módulo, não do bot**. É a exceção ao "nada global" do ADR
  0003, deliberada: o store não guarda estado do bot, só o id da unidade de trabalho de cada
  contexto assíncrono, então dois bots no processo não se enxergam. Em troca, todo `createLogger`
  carimba o `trace` sem o app configurar nada, inclusive um `config.logger` criado com `createLogger`.

  Uma **unidade de trabalho** é: a mensagem (também o clique, o comando nativo e a
  expiração de um passo, que passam pela fila do chat), o evento direto do transport, o request
  HTTP de uma rota, a execução de um job e o boot dos plugins. Cada uma abre o próprio `trace`.
- **Propagação sem o plugin repassar nada:**
  - o `createLogger` lê o escopo a cada linha emitida (`mixin` do pino), o que cobre o `ctx.log`,
    os logs do core e a linha do `plugin.error`. Não copia os campos de quem loga: o pino só
    chama o `mixin` na linha que sai;
  - o sinal `log` (ADR 0105) leva o `trace` nos `fields`, mesmo com logger próprio;
  - a fila de saída já executa o job no contexto assíncrono de quem enfileirou (ADR 0105/#163), então
    o envio e o `outbound.sent` saem no trace da mensagem que gerou a resposta;
  - o scheduler guarda o `trace` de quem chamou `at`/`every` como `cause` no documento do job, e
    cada execução abre um `trace` próprio. O `job.run` leva o `cause`. **O job cria, não herda:**
    herdar misturaria a mensagem com um trabalho que pode rodar horas depois, de um restart, ou
    várias vezes (série); com `cause` o elo continua sem esse custo.
- **`plugin.error`:** a linha do erro sai no trace do trabalho que falhou (pela regra acima). O
  payload do evento do barramento **não ganha campo**: o evento é contrato dos plugins e os testes
  de contrato comparam o objeto inteiro. Quem precisa do trace assina o sinal `log`.

### `traceparent` no HTTP

- **Decisão:** o core **adota** o `trace-id` de um `traceparent` de entrada válido (versão 00, ids
  não zerados) e **devolve** o header na resposta, com o mesmo `trace-id` e um `span-id` novo.
  Header ausente ou malformado é ignorado: o request segue com um trace gerado.
- **Por quê confiar:** o objetivo é cruzar a linha de acesso do Traefik com a do bot, o que só
  funciona com o mesmo id. O risco de confiar é um cliente escolher o `trace` do próprio request,
  o que só mistura as linhas dele; para poluir a jornada de outra mensagem ele precisaria
  adivinhar 128 bits. A alternativa (gerar sempre e só registrar o de fora) exigiria um segundo
  campo e uma junção a mais na consulta, sem ganho de segurança que justifique.
- Fora: o `/health` (sonda a cada poucos segundos, só ruído) e o WebSocket (a conexão vive além
  do request; a decisão de aceitar não vira `http.request`). Por isso os logs dos callbacks de
  WebSocket saem sem `trace`.

### Trilha

Eventos `info` do core, com os campos do dicionário do ADR 0118:

| `event` | Onde | Campos |
| --- | --- | --- |
| `message.received` | entrada da mensagem, do clique e do comando nativo | `chat`, `sender`, `chatType`, `kind`, `messageId` |
| `message.handled` | fim do tratamento | `route`, `command`, `step`, `status`, `durationMs` |
| `outbound.sent` | fila de saída | `kind`, `status`, `replyTo`, `durationMs` |
| `step.entered` / `step.expired` | conversa | `plugin`, `step` |
| `job.run` | scheduler | `job`, `plugin`, `status`, `durationMs`, `cause` |
| `http.request` | rota HTTP | `method`, `route`, `status`, `durationMs` |

- **Sem conteúdo de mensagem, nunca, em nível nenhum** (decisão de 2026-10-23): só o fato, o tipo e
  os metadados. `chat` e `sender` saem pseudonimizados pelo logger do bot (ADR 0119). `route` do
  HTTP é o padrão da rota, sem valores de parâmetro, query string nem corpo.
- `message.handled` e `outbound.sent` existem **também** como sinais dos observadores, e os sinais
  continuam como antes. A trilha mede o `durationMs` do handler sempre (um `performance.now()` por
  mensagem); o sinal continua dependendo de observador para medir a espera na fila.
- No `outbound.sent`, `durationMs` é a espera na fila até o despacho ao transport (taxa anti-ban e
  retries inclusos), o mesmo `queuedMs` do sinal.
- **Config:** `createBot({ trail: 'info' | 'debug' | 'off' })`, padrão `'info'`. `'debug'` emite os
  mesmos eventos em `debug` e `'off'` os silencia; erros e avisos não mudam. É a exceção consciente
  à regra "um nível por evento" do ADR 0118: quem rebaixa a trilha é o operador, não o código.
- **Volume:** 2 a 3 linhas por mensagem em `info` (`message.received`, `message.handled`, mais um
  `outbound.sent` por resposta).

### Custo

O `AsyncLocalStorage` roda uma vez por unidade de trabalho (a mensagem já pagava o do tenant), o
id vem de `randomUUID`, e as linhas da trilha só custam quando o nível as emite.

O bench padrão usa logger `silent` (`packages/testing/src/test-bot.ts`), então não enxerga o custo
das linhas. Os cenários `throughput-logged` (logger `info`, destino nulo, `trail: 'info'`) e
`throughput-logged-off` (o mesmo, com `trail: 'off'`) medem esse custo contra o `throughput`
(`silent`). Medição com 6 execuções alternadas de cada (processo novo por execução), AMD Ryzen 7
5700U, Node 24.21, máquina ociosa:

| Cenário | msg/s local (min a max) | msg/s no runner do CI |
| --- | --- | --- |
| `throughput` (`silent`) | 12.097 a 12.280 (mediana ~12,2k) | ~9,4k |
| `throughput-logged` (`info`, `trail: 'info'`) | 6.441 a 6.483 (mediana ~6,46k) | ~4,9k |
| `throughput-logged-off` (`info`, `trail: 'off'`) | 11.950 a 12.369 (mediana ~12,2k) | ~9,5k |

Reproduzir: `pnpm build` e `node bench/dist/main.mjs --scenario throughput-logged` (e os outros
dois nomes). O custo vem todo da trilha: com ela desligada o logger em `info` empata com o
`silent` (só 2 linhas saem no processo), e com ela ligada saem cerca de 2,67 linhas por mensagem
e a vazão cai quase pela metade (~47% local; no runner, 4.910 contra ~9,4k). A meta de 5.000
msg/s do plano vale para o `throughput` (`silent`); a trilha ligada em `info` fica abaixo dela no
runner, por isso os dois cenários `-logged` não têm meta (`min: 0`), só o número. O número é o pior
caso, em que o handler não faz nada além de passar pela trilha; o custo por linha é fixo, então
pesa menos num bot cujo handler faz I/O. Quem precisa da vazão máxima usa `trail: 'off'`.

### Relação com o `ctx.audit` (#224)

A auditoria pode gravar o `trace` corrente junto da ação, ligando a ação ao log de diagnóstico. Não
é feito aqui.

## Consequências

- Investigar vira: pseudônimo do usuário → `trace` da mensagem com erro → `| json | trace="…"`
  (roteiro em `packages/core/docs/logger.md`).
- Um logger próprio que não vem do `createLogger` só leva o `trace` na linha se o ler do contexto;
  o sinal `log` o leva sempre. Um logger que copia os campos a cada chamada para carimbar o
  `trace` foi descartado: os testes do sinal `log` exigem que os campos não sejam lidos sem
  observador.
- Evento novo na trilha é minor; renomear ou remover quebra (ADR 0118).
- O timer que um plugin cria no `setup` herda o trace do boot enquanto viver, e o trabalho disparado
  por ele sai com esse trace, a menos que abra o próprio. É o custo de propagar sem o plugin
  repassar nada.
- Ficam fora: o `trace` no payload do `plugin.error`, `ctx.audit` (#224) e qualquer mudança no
  pseudônimo (#231).
