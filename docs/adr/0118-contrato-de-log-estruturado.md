# ADR 0118 — Contrato de log estruturado: `event` estável, campos padronizados e formato para o Loki

**Status:** Aceito (2026-10-24) · Detalha o logger do **D11** (escopo do core, plano §5) ·
Complementa **D87** ([ADR 0087](0087-log-legivel-e-baileys-em-warn.md)) e **D105**
([ADR 0105](0105-sinal-de-log-nos-observadores.md))

## Contexto

Os logs do kernel não servem para auditar nem para reconstruir o que levou a um bug (#230). O
levantamento de 2026-10-23 cobriu cerca de 100 chamadas em `packages/*/src`:

- **Valor interpolado na mensagem** (`comando "${command}" rejeitou depois do prazo`). Cada linha
  tem um texto diferente, e o Loki não agrupa nem filtra por tipo de evento.
- **Sem nome de evento estável.** O filtro depende do texto em PT, que muda a cada ajuste de
  redação.
- **Campos sem padrão:** `err` × `error` (#229), prefixo `dashboard:` escrito à mão na mensagem
  com o binding `plugin` já presente, `reason` × `message` para o mesmo fim, `chatId` ao lado de
  `plugin` e `command` sem sufixo.
- **Formato pouco amigável ao agregador:** `level` numérico do pino (`30`, `50`), `time` em epoch
  ms, e nenhum campo que diga qual bot, versão ou ambiente gerou a linha.

O alvo de operação é Grafana Alloy → Loki.

Alternativas consideradas para o `event`:

- **Campo livre** (`log.warn('…', { event: 'x.y' })`). Não muda a interface, mas nada garante que
  o kernel o preencha, que o nível de um evento seja sempre o mesmo, nem que a mensagem fique sem
  valor interpolado. Seria convenção mantida só na revisão.
- **Nome em string com mapa global** (`log.event('command.timeout', fields)`). O nível e a mensagem
  teriam de vir de um registro em runtime, e um plugin de terceiro precisaria registrar o próprio
  catálogo antes de logar.

## Decisão

### Formato da linha

Uma linha JSON por chamada, no formato que o Loki e o Grafana leem sem pipeline extra:

```json
{"level":"error","time":"2026-10-23T14:03:22.418Z","bot":"principal","service":"lumabot",
 "version":"0.9.0","env":"production","plugin":"ai","event":"command.timeout","command":"imagem",
 "chat":"1203@g.us","err":{"type":"TimeoutError","message":"…","stack":"…"},
 "msg":"comando rejeitou depois do prazo"}
```

- **`level` em texto** (`trace`…`fatal`) e **`time` ISO 8601 UTC**, pelos `formatters` do pino.
- **Sem `pid` e `hostname`.** No contêiner eles não identificam nada; quem identifica a origem são
  os bindings base.

### `event`: helper tipado

- **`defineLogEvent({ name, level, message })`** devolve um `LogEvent` congelado. O nome segue
  `<área>.<coisa>.<verbo>` em kebab-case, com pelo menos dois segmentos (`command.timeout`,
  `plugin.reload.failed`), e é validado na definição: nome fora da regra lança.
- **`log.event(evento, campos?)`** emite a linha no nível do evento, com `msg` = a mensagem do
  evento e o campo `event` = o nome. O nível pertence ao evento: o mesmo `event` nunca aparece em
  dois níveis, e um alerta pode ser escrito só sobre ele.
- A mensagem é fixa, em PT, para quem lê. **Os valores vão em campos.** Texto de orientação
  ("declare dependsOn no plugin dono do papel") cabe na mensagem; nome de plugin, comando ou motivo,
  não.
- **`log.<nível>(mensagem, campos?)` continua** para o app e para plugins de terceiros. O kernel
  (core, transports e plugins oficiais) usa só `log.event`.
- **Catálogo do core** num módulo só (`logger/events.ts`, um `export const` por evento, importado
  como `import * as LOG`), fora da API pública: o contrato é o nome, não o objeto. **Evento novo é
  minor; renomear ou remover quebra**, como os sinais do ADR 0105. Cada plugin oficial e cada
  transport mantém o próprio catálogo (`src/log-events.ts`), com a área do pacote (`dashboard.*`,
  `metrics.*`, `baileys.*`, `web.*`). Evento que todo transport tem usa a área `transport` e o
  mesmo nome do core (`transport.handler.failed`); o binding `transport` diz qual foi.
- `event` é chave reservada: um campo `event` passado em `campos` é sobrescrito pelo nome do evento.
  O nome de evento do barramento ou do transport que antes ia em `event` passa a `eventName`.

### Campos

- **Bindings base** em toda linha do bot: `bot` (a `session`) vem sozinho. `service`, `version` e
  `env` o app passa em **`createBot({ logBindings })`**: o core não lê variável de ambiente nem o
  `package.json` do app (ADR 0030). Valem também sobre o `config.logger` do app.
- **Dicionário de campos** com tipo (`StandardLogFields`), que plugins também usam: `err`, `event`,
  `service`, `bot`, `version`, `env`, `plugin`, `transport`, `chat`, `sender`, `messageId`,
  `command`, `step`, `role`, `route`, `status`, `reason`, `durationMs`, `trace`. Outros nomes
  continuam livres.
- **`chatId` vira `chat`** e `senderId` vira `sender`, no binding por mensagem e nos campos.
  `reason` é o motivo em texto curto; o erro vai sempre em `err`.

### Regra no lint

Um plugin Grit do Biome (`tooling/biome/log-event.grit`) barra, nos `src` dos pacotes do kernel
(fora dos testes), chamada de `trace`/`debug`/`info`/`warn`/`error`/`fatal` sobre um logger e
mensagem de `defineLogEvent` que não seja literal de string. Adapter que repassa linha de terceiro
(o logger do Baileys) suprime a regra com justificativa.

### `pretty` (ADR 0087)

- O cabeçalho continua hora, nível, `[plugin]` e mensagem. `event` e os bindings base (`service`,
  `bot`, `version`, `env`) ficam de fora: no terminal são ruído constante, e o `event` é para o
  agregador.
- Campo de texto com quebra de linha sai nas linhas seguintes, recuado, como o `err`. É o caso da
  tabela de boot dos plugins, que sai do `msg` para o campo `report`.

### Sinal `log` (ADR 0105)

O sinal carrega o `event` nos `fields`, como qualquer campo, e o `chat` no lugar do `chatId`.

### Loki

- Rótulos de stream só de baixa cardinalidade: `service`, `bot`, `env`, `level` e, quando houver,
  `plugin`. `event`, `chat`, `command` e `trace` ficam no corpo e são filtrados com `| json`.
- A doc de operação traz o pipeline do Alloy (`loki.source.docker` + `loki.process` com
  `stage.json` e `stage.labels`).

## Consequências

- Filtro e alerta passam a ser por `event`, estável entre ajustes de redação.
- **Quebra antes do 1.0** (changeset minor, com nota): quem parseia `level` numérico, `time` em
  epoch, `pid`/`hostname` ou o `chatId` precisa se ajustar. `Logger` ganha o método `event`, então
  um logger próprio do app (`config.logger`) ou um fake de teste precisa implementá-lo.
- Os testes que achavam linhas pelo texto passam a achá-las pelo `event`, e o texto pode mudar sem
  quebrá-los.
- A mensagem fica menos autoexplicativa no terminal (o comando sai em `command=imagem`, não na
  frase). O `pretty` mostra os campos ao lado, então o leitor não perde nada.
- `log.event` aloca um objeto por linha emitida para juntar `event` e campos; em nível desabilitado
  ele sai antes, sem alocar.
- Correlação por mensagem (#232), pseudônimo do id do usuário (#231) e log de auditoria (#224)
  ficam fora: o `trace` está no dicionário, mas nada o preenche ainda.
