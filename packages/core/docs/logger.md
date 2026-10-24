# Logger

`createLogger` cria o logger estruturado do kernel: uma linha JSON por chamada, sobre pino. A
API pública é a interface `Logger`, sem o pino, então plugins não dependem dele. O formato da
linha, o `event` e os nomes de campo seguem o contrato do
[ADR 0118](../../../docs/adr/0118-contrato-de-log-estruturado.md).

```ts
import { createLogger, defineLogEvent } from '@usebridger/core';

const log = createLogger({ level: 'debug', bindings: { service: 'meu-bot' } });

const ForecastSent = defineLogEvent({
  name: 'clima.forecast.sent',
  level: 'info',
  message: 'previsão enviada',
});

log.event(ForecastSent, { chat, cidade: 'Recife' });
log.warn('fila cheia', { chat, pending: 100 });
log.error('falha ao enviar', { err });
```

## A linha

```json
{"level":"info","time":"2026-10-23T14:03:22.418Z","bot":"principal","service":"meu-bot",
 "plugin":"clima","chat":"1203@g.us","cidade":"Recife","event":"clima.forecast.sent",
 "msg":"previsão enviada"}
```

- `level` em texto (`trace` … `fatal`) e `time` em ISO 8601 UTC: o Loki e o Grafana leem sem
  pipeline extra.
- Os bindings vêm logo depois, na ordem em que os filhos foram criados; os campos da chamada, em
  seguida; o `msg`, por último.
- Não há `pid` nem `hostname`. Quem identifica a origem são os bindings base
  ([abaixo](#bindings-base)).

## Eventos

`log.event(evento, campos?)` é a forma de logar do kernel e a recomendada para plugins. O evento
define o nível e a mensagem; a chamada só passa os campos.

```ts
const ReportFailed = defineLogEvent({
  name: 'relatorio.envio.failed',
  level: 'error',
  message: 'falha ao enviar o relatório',
});

ctx.log.event(ReportFailed, { chat, err });
```

- **Nome:** `<área>.<coisa>.<verbo>` em kebab-case, com pelo menos dois segmentos
  (`command.timeout`, `plugin.reload.failed`). A área de um plugin é o nome dele. Nome fora da
  regra faz o `defineLogEvent` lançar `TypeError`, no carregamento do módulo. O mesmo vale para
  um `level` fora de `trace`…`fatal` e para uma `message` vazia ou que não é texto.
- **Nível fixo:** o mesmo `event` sai sempre no mesmo nível, então um alerta pode ser escrito só
  sobre o nome.
- **Mensagem fixa:** texto em PT para quem lê, sem valores. O valor vai em campo: `command=imagem`,
  e não `comando "imagem" falhou`. Texto de orientação ("declare dependsOn no plugin dono do papel")
  cabe na mensagem.
- **`event` é reservado:** um campo `event` passado nos campos é sobrescrito pelo nome. Para o nome
  de um evento do barramento ou do transport, use `eventName`.
- **`level`, `time` e `msg` também:** são do pino. Se vierem nos campos (de `log.event` ou dos
  métodos por nível), são descartados, para a linha não ter chave duplicada nem um `level`
  trocado, que é rótulo de stream no Loki.
- Em nível desabilitado, `log.event` volta antes de ler os campos.

O nome é contrato com quem filtra e alerta: evento novo é minor, renomear ou remover quebra. Os
eventos do core, dos transports e dos plugins oficiais estão em [Eventos de log](log-events.md).

`log.<nível>(mensagem, campos?)` continua valendo, para o app e para plugins que não precisam de
evento estável. No `src` dos pacotes do kernel, o Biome barra essa forma
([`log-event.grit`](../../../tooling/biome/log-event.grit)).

## Campos

O mesmo nome para a mesma coisa em core, transports e plugins (`StandardLogFields`):

| Campo | Tipo | O que é |
| --- | --- | --- |
| `err` | `unknown` | O erro: sai com `type`, `message`, `stack` e `cause` |
| `event` | `string` | Nome do evento; quem preenche é o `log.event` |
| `service`, `version`, `env` | `string` | Bindings base do app (`logBindings`) |
| `bot` | `string` | Sessão do bot; posto pelo bot |
| `plugin` | `string` | Plugin que logou (binding do `ctx.log`) |
| `transport` | `string` | Transport (binding do logger do transport) |
| `chat` | `string` | Id do chat (binding do `log` por mensagem) |
| `sender` | `string` | Id de quem mandou a mensagem |
| `messageId` | `string` | Id da mensagem |
| `command` | `string` | Nome do comando |
| `step` | `string` | Passo de conversa |
| `role` | `string` | Papel exigido por um comando |
| `route` | `string` | Rota HTTP ou do transport |
| `status` | `string \| number` | Status (HTTP, plugin, conexão) |
| `reason` | `string` | Motivo em texto curto; o erro vai em `err` |
| `durationMs` | `number` | Duração |
| `trace` | `string` | Id de correlação; reservado, ainda sem uso |

Outros nomes continuam livres. O dicionário tem tipo: `{ chat: 1 }` não compila.

## Bindings base

O bot põe `bot` (a `session`) em toda linha, também sobre o `config.logger` do app. `service`,
`version` e `env` vêm de `createBot({ logBindings })`: o core não lê variável de ambiente nem o
`package.json` do app.

```ts
import pkg from './package.json' with { type: 'json' };

createBot({
  transport,
  session: 'principal',
  logBindings: { service: 'lumabot', version: pkg.version, env: process.env.NODE_ENV },
});
```

## Opções

| Opção | Padrão | O que faz |
| --- | --- | --- |
| `level` | `'info'` | Nível mínimo: `trace`, `debug`, `info`, `warn`, `error`, `fatal` ou `silent` |
| `format` | `'json'` | `'pretty'` escreve texto para o terminal ([Saída legível em dev](#saída-legível-em-dev)) |
| `destination` | stdout | Qualquer `{ write(line: string): void }`: recebe cada linha JSON com `\n` |
| `bindings` | — | Campos presentes em toda linha deste logger e dos filhos |
| `redact` | — | Caminhos de campos trocados por `[REDACTED]` (sintaxe do pino) |
| `secrets` | — | Valores trocados por `[REDACTED]` em qualquer lugar da linha: lista fixa ou `SecretSet` (fonte viva) |

O core não lê variável de ambiente: o nível vem de quem cria o logger (config do bot ou app).

## Contexto: `plugin` e `chat`

`child(bindings)` devolve um logger que acrescenta os campos a toda linha; filhos de filhos
acumulam. O `Bot` dá a cada plugin `ctx.log = root.child({ plugin })`, e o que roda por mensagem
recebe o filho com o chat:

```ts
const pluginLog = root.child({ plugin: 'clima' });
pluginLog.child({ chat: message.chat.id }).event(ForecastSent, { cidade });
// {"level":"info",...,"plugin":"clima","chat":"grupo-1","cidade":"Recife","event":"clima.forecast.sent",...}
```

As chaves `event`, `level`, `time` e `msg` nos bindings do `child` são descartadas. O filho herda
nível, destino e redação do pai. Repetir uma chave num filho (`child({ chat })`
sobre um logger que já tem `chat`) gera a chave duas vezes na linha; leitores de JSON ficam com a
última. Crie o filho a partir do logger do plugin, não do filho de outro chat.

## Erros

Passe o erro no campo **`err`**: ele é serializado com `type`, `message`, `stack` e a `cause`
(recursiva, também com stack). Um `Error` sob outra chave do primeiro nível dos campos
(`{ error }`, `{ falha }`) sai serializado igual, sob o próprio nome; aninhado num objeto
(`{ ctx: { error } }`), não.

```ts
log.event(ReportFailed, { err: new Error('envio falhou', { cause }) });
```

## Segredos

Duas camadas, combináveis:

- **`secrets`** (por valor): a lista de valores secretos, por exemplo os campos `secret` da
  config já validada. Qualquer ocorrência na linha vira `[REDACTED]`: na mensagem, em qualquer
  campo, nos bindings e em `err.message`/`err.stack`. É a proteção que não depende de saber
  onde o segredo vai aparecer; use-a para os segredos da config.
- **`redact`** (por caminho): nomes de campo que nunca saem, qualquer que seja o valor:
  `['password', 'config.apiKey', '*.token']` (`*` casa um nível). Útil para campos sensíveis
  cujo valor não se conhece de antemão (token de sessão recebido em runtime).

```ts
createLogger({ secrets: [config.openai.apiKey], redact: ['*.token'] });
```

Segredos descobertos depois da criação do logger (a config de plugin é resolvida no setup e
muda no reload) entram por uma fonte viva: passe um `SecretSet` em vez da lista. O logger, e
todos os filhos, relê os valores quando o conjunto muda; a config de plugin escreve nele
([Config](config.md#segredos)).

```ts
const secrets = createSecretSet();
const log = createLogger({ secrets });
secrets.set('plugin:ai', [apiKey]);   // a partir daqui, apiKey sai como [REDACTED]
secrets.delete('plugin:ai');
```

Limites: com lista fixa, os segredos são fixados na criação (filhos herdam); um segredo comum
censura também o texto que coincidir com ele. Valores com menos de 4
caracteres são ignorados: censurar `"1"` ou `"on"` apagaria pedaços de todo log, e um valor tão
curto não protege nada de qualquer forma.

## Logger próprio

`config.logger` aceita qualquer objeto com a interface `Logger`, que inclui o `event`. O bot chama
o `event` do seu logger (o sinal `log` dos observadores sai à parte, depois). Quem embrulha outro
logger repassa assim:

```ts
event: (event, fields) => inner[event.level](event.message, { ...fields, event: event.name }),
```

## Logger silencioso

`createNoopLogger()` (interno do kernel, não exportado ([ADR 0030](../../../docs/adr/0030-biblioteca-sem-runner.md))) descarta tudo sem ler os campos nem
alocar: para os testes do core e como padrão quando ninguém passou logger. `child()` devolve o
próprio no-op.

## Desempenho

Em nível desabilitado o pino não serializa nada; os campos só são lidos quando a linha sai, e o
`log.event` nem monta o objeto com o `event`. A censura por `secrets` roda só nas linhas emitidas
e só quando há segredo configurado (com `SecretSet`, a lista é recalculada só quando o conjunto
muda).

## Saída legível em dev

`format: 'pretty'` (no bot, `logFormat: 'pretty'`) troca o JSON por uma linha de texto
([ADR 0087](../../../docs/adr/0087-log-legivel-e-baileys-em-warn.md)):

```text
14:03:22 INFO  conexão aberta
14:03:25 WARN  [media] figurinha falhou chat=1203@g.us
    Error: ffmpeg saiu com 1
        at ...
    causa: Error: ENOENT
        at ...
```

- Hora local, nível, `[plugin]` quando houver, a mensagem e os demais campos em `chave=valor`
  (texto com espaço entre aspas, objeto em JSON compacto).
- Ficam de fora o `event` e os bindings base (`bot`, `service`, `version`, `env`): no terminal são
  ruído constante, e o `event` é para o agregador.
- O `err` sai nas linhas seguintes, recuado: a stack e, em seguida, a de cada `causa`. Um erro
  sob outra chave sai ali também, prefixado com o nome do campo (`error: Error: ...`). Texto de
  várias linhas também: a tabela de boot no campo `report` sai sem rótulo; qualquer outro campo
  com `\n` sai com `campo:` antes do bloco. Caracteres de controle (exceto `\n`) viram `\u00XX`,
  para um valor não injetar ANSI no terminal.
- Colorido só no stdout de um terminal; `NO_COLOR` desliga. Com `destination` próprio, texto puro.
- A conversão roda sobre a linha JSON já censurada: `secrets` e `redact` valem igual.

O padrão segue `'json'`, que é o que agregadores e arquivos de log esperam. O core não depende de
`pino-pretty`; quem prefere o dele pode encaminhar a saída JSON (`node app.js | npx pino-pretty`).

## Loki

Com Grafana Alloy → Loki, os rótulos de stream ficam só com o que tem baixa cardinalidade:
`service`, `bot`, `env`, `level` e `plugin`. `event`, `chat`, `command` e `trace` ficam no corpo e
são filtrados com `| json`. O pipeline do Alloy está em
[Rodar em produção](/usebridger/comecando/producao/#loki).

```logql
{service="lumabot", env="production"} | json | event="command.timeout"
sum by (event) (count_over_time({service="lumabot", level="error"} | json [1h]))
```
