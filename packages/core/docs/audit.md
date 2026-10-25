# Log de auditoria (`ctx.audit`)

Quem fez o quê, quando e sobre o quê, com cadeia de hash para detectar adulteração. O porquê
está no [ADR 0122](../../../docs/adr/0122-log-de-auditoria-no-kernel.md). Não é o log do pino
(`ctx.logger`, operacional) nem a trilha do [ADR 0120](../../../docs/adr/0120-trace-e-trilha-de-eventos.md)
(diagnóstico, sem conteúdo): é registro de conformidade.

## Gravar

```ts
ctx.audit.record({
  action: 'inbox.ticket.transfer',
  target: { type: 'ticket', id: ticket.id },
  outcome: 'success', // padrão; também 'denied' e 'error'
  details: { from: 'ana', to: 'beto', token: 'x' }, // token vira [REDACTED]
});
```

- **Síncrono e nunca aguardado:** monta o evento, redige e enfileira. Quem grava no storage é um
  dreno em segundo plano. Valor que não é JSON (função, `bigint`, `Date`) em `details` lança
  `TypeError` na hora.
- **Custo medido:** `record` com `details` pequeno e storage em memória tem p50 ~0,013 ms e p99
  ~0,15 ms por chamada (meta do ADR 0122: p99 < 1 ms); o caminho da mensagem fica em p99 ~0,33 ms
  (ver [`bench/docs`](../../../bench/docs/README.md#com-o-ctxauditrecord)).
- **`action`** é `<plugin>.<recurso>.<verbo>`. O core exige o prefixo `<nome do plugin>.` e
  reserva `kernel.` e `audit.`: um plugin não forja a ação de outro nem a do kernel.
- **Ator:** o `ctx` do plugin já está amarrado ao nome dele, então o evento sai com
  `actor: { kind: 'plugin', name }`. Não existe campo de ator no `record`. O core (não o
  plugin) entra com o titular num escopo assíncrono interno (request autenticado ou fluxo LGPD):
  ali o ator é o `user`/`contact` e o evento leva `via: <plugin>`, `ip` e `userAgent`. `system` é só das chamadas internas do core.
- **Redação:** valores dos segredos do bot e, em qualquer nível, chaves terminadas em
  `password`, `passwd`, `token`, `secret` ou `apiKey` (`accessToken`, `clientSecret`,
  `dbPassword`), além de `authorization` e `cookie`, viram `[REDACTED]`. A comparação ignora
  maiúsculas, `_` e `-` (`API_KEY`, `refresh_token`). Só o sufixo conta: `tokenizer` fica em claro. A chave `content` é **removida**; para guardá-la, `includeContent: true` no
  próprio `record`.
- `tenant` (ADR 0068), `session`, `trace` (ADR 0120) e `at` (relógio do servidor) vêm do core.

## Ações do kernel

O core grava sozinho, com `actor` `system` (chamada direta de `bot.plugins`/`bot.config`) ou
`{ kind: 'plugin', name }` (via `ctx.admin`, ADR 0107):

| Ação | Alvo | `details` |
| --- | --- | --- |
| `kernel.plugin.enable` / `disable` / `reload` | `plugin` | `{ plugin }` |
| `kernel.config.update` (`setOverrides`) | `plugin` | `{ plugin, changes }`: diff por caminho `{ from, to }`; campos `secret` ficam no `SECRET_MASK` |
| `kernel.secret.update` (`setSecret`/`clearSecret`) | `plugin` | `{ plugin, path, op: 'set' \| 'clear' }`; nunca o valor |
| `kernel.boot` / `kernel.stop` | | `{ version, plugins }` (plugins carregados) |

`outcome` é `success` ou `error` (exceção, ou `setup` novo que falhou no `reload`/`enable`). A
recusa do `ctx.admin` sobre o próprio plugin (ADR 0107) grava `denied`. `kernel.stop` é gravado
antes do dreno do `stop`, e só se o `kernel.boot` foi gravado.

## Consultar e verificar (só admin)

`ctx.audit.query` e `ctx.audit.verify` exigem o plugin em `adminPlugins` (ADR 0107); os demais
rejeitam com `AuditPermissionError`.

```ts
const page = await ctx.audit.query({ action: 'inbox.ticket.transfer', limit: 50 });
const next = await ctx.audit.query({ after: page.next }); // cursor por seq
const result = await ctx.audit.verify(); // { ok, checked, brokenAt? }
```

Filtros: `from`/`to` (por `at`), `actor`, `action`, `target`, `outcome`, `tenant`, `after`,
`limit` (padrão 100, máximo 1000). Num request de tenant o core impõe o tenant do escopo,
ignorando o `tenant` do filtro. Não há `update` nem `delete`.

## Fila, falha e descarte

- Flush a cada 1 s ou 100 eventos, e no `stop`. Um insert por vez, em ordem de `seq`; `seq` e
  `prevHash` só avançam depois do insert confirmado.
- Storage falhou: log `error` `audit.flush.failed`, a fila retém e tenta de novo (1 s, dobrando
  até 30 s). Depois de qualquer erro, inclusive timeout, o topo da cadeia é relido: se o insert
  ambíguo entrou, o evento sai da fila em vez de duplicar o `seq`.
- Limite de 10.000 eventos em memória: o evento novo é descartado. O log `audit.dropped` desse
  caso sai uma vez a cada 10 s, com a soma; o sinal de observador sai a cada descarte.
- Evento que o storage recusa sempre (o banco responde à leitura, mas o insert falha 10 vezes
  seguidas no mesmo evento) é descartado com `reason: 'rejected'` e log `error`, para não travar
  a cadeia. `details`, `action` e `target` com caractere NUL são recusados no `record`.
- Trava de sessão perdida (ADR 0070): a fila é descartada sem gravar, para não bifurcar a cadeia.
- `stop`: drena até `min(shutdown.hookTimeoutMs, o que sobrou de shutdown.timeoutMs)`; insert
  pendurado não segura o prazo, e o resto é descartado. O evento com insert em voo conta como
  descartado, embora possa ainda gravar.
- Todo descarte gera o log `error` `audit.dropped` e o sinal de observador `audit.dropped`
  (`{ count, reason }`, `count` é o incremento): `queue-full`, `lease-lost`, `shutdown`, `rejected`, ou
  `before-observer` para o acumulado de antes de haver observador.

```ts
ctx.observe('audit.dropped', ({ count, reason }) => counter.inc({ reason }, count));
```

Numa **queda do processo** a fila inteira se perde (até 10.000 eventos, se o storage estava fora).

## Integridade

`hash = HMAC-SHA256(chave, prevHash + JSON canônico do evento sem o hash)`, com a chave derivada
(HKDF) da `BRIDGER_SECRET_KEY`. Uma cadeia por sessão; o primeiro elo usa `prevHash` de 64 zeros.

O que ela promete e o que não:

- Quem tem só o banco **não** edita um evento do meio nem recalcula a cadeia dali em diante
  (falta a chave): `verify` aponta o primeiro elo quebrado.
- Quem tem o banco **e** a chave forja tudo.
- Quem tem só o banco pode **apagar o final**, ou tudo, sem que a cadeia acuse: falta de eventos
  no fim não é elo quebrado. A defesa é ancorar o topo fora do banco (ponto de extensão futuro).
- Sem `BRIDGER_SECRET_KEY` a chave é fixa e pública: só detecta edição ingênua, e o boot
  avisa com `audit.unkeyed`. Adicionar a chave depois faz o `verify` acusar o histórico anterior
  (com chave presente ele não cai para a chave pública).
- Rotação: o `verify` aceita `BRIDGER_SECRET_KEY_PREVIOUS` só nos elos antes do primeiro assinado
  com a atual.
- O storage não tem índice único em `seq`: um insert tardio de uma tentativa que o dreno já
  considerou perdida pode, raramente, deixar um `seq` duplicado; o `verify` o aponta.
- Trocar a chave invalida a verificação do passado; mantenha a anterior em `BRIDGER_SECRET_KEY_PREVIOUS`.
- O `verify` aceita o buraco no início deixado por uma expurgação: o primeiro elo restante tem
  `prevHash === lastHash` e `seq === toSeq + 1` de um `kernel.audit.purge` gravado depois.

## Retenção e expurgação

```ts
createBot({ audit: { retentionDays: 365 } }); // padrão 1825 (5 anos); inteiro positivo
```

Valor inválido lança `BotConfigError`. A expurgação roda no máximo uma vez a cada 24 h (ator
`system`, sessão e cadeia do bot), disparada pela primeira gravação da auditoria depois do boot
e de cada dia seguinte:

1. Acha o maior `seq` com `at` anterior ao corte (`toSeq`) e o `hash` desse elo (`lastHash`). O
   corte é por `at`, mas o que sai é o prefixo `seq <= toSeq`: se o relógio voltou, o prefixo
   inclui eventos mais novos, para a cadeia continuar contígua. Nada vencido: não grava nada.
2. Grava `kernel.audit.purge` com `details: { fromSeq, toSeq, count, lastHash }` e faz `flush`.
3. Só se o evento aparece gravado (o `record` pode ter sido descartado, o storage pode ter
   falhado), apaga `seq <= toSeq`. Senão sai o log `warn` `audit.purge.skipped` e a próxima
   passada tenta de novo. Queda no meio deixa um purge sem buraco, inofensivo.

Logs: `audit.purged` (`info`), `audit.purge.skipped` (`warn`), `audit.purge.failed` (`error`).

Não é um job do `ctx.scheduler` nem um timer: o scheduler persiste e é por plugin, então agendar a
cada boot duplicaria a série, e o boot do bot não pode deixar timer vivo (os testes de ciclo de
vida contam). O gatilho é a passada de `tick`, chamada (1) no boot, (2) quando a auditoria grava
eventos e (3) a cada renovação da trava de sessão (ADR 0070), que é o que cobre um bot ligado e
sem gravar. Em storage sem trava (memória) só valem o boot e a gravação; é aceitável porque esse
storage não guarda a cadeia entre boots. O intervalo de 24 h é medido em memória (relógio
monotônico) e recomeça a cada boot; passada que adia ou falha tenta de novo no próximo gatilho.
O apagamento é em lotes de 1000 `seq`. No `stop` (e na perda da trava) a passada em voo para e o
shutdown a aguarda, com o prazo da auditoria, antes de drenar a fila.

## Verificar por script do app

O core não abre o banco, então o app monta o próprio script com o `StoragePort` que já usa:

```ts
import { verifyAudit } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';

const storage = sqlite({ path: './data/bot.db' });
const result = await verifyAudit({ storage, session: 'default' }); // BRIDGER_SECRET_KEY do ambiente
await storage.close();
if (!result.ok) {
  console.error('cadeia quebrada em', result.brokenAt);
  process.exit(1);
}
console.log(`ok: ${result.checked} eventos`);
```

Rode fora do pico: o `verify` lê a coleção inteira, em lotes por `seq`.

## Uso interno do core

`audit.record({ action: 'kernel.…', details, actor? })` (tipo `Audit` em `src/audit/audit.ts`)
é a gravação do core: aceita qualquer `action`, usa o titular do escopo e, sem ele, `system`;
plugin admin que age passa `actor: { kind: 'plugin', name }`. `kernel.audit.purge` grava
`details: { fromSeq, toSeq, count, lastHash }` antes de apagar `seq <= toSeq` na coleção
`audit` do namespace `$audit`.
