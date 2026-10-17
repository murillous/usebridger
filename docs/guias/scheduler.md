# Scheduler

O scheduler roda uma tarefa do plugin numa data marcada, mesmo que o bot tenha reiniciado no meio:
o job fica no storage. O detalhe está em [Scheduler no core](../../packages/core/docs/scheduler.md).

## Agendar e tratar

O plugin registra o handler do job no `setup` e agenda com `at`, de onde quiser:

```ts
import { command, definePlugin } from '@usebridger/core';

type Lembrete = { chatId: string; texto: string };

export const lembrete = definePlugin({
  name: 'lembrete',
  version: '0.1.0',
  engine: '<1.0.0',
  requires: ['send.text'],
  setup(ctx) {
    ctx.scheduler.on('lembrar', async (payload) => {
      const { chatId, texto } = payload as Lembrete;
      await ctx.send.send(chatId, `⏰ ${texto}`);
    });

    ctx.commands.add(
      command({
        name: 'lembrar',
        description: 'Lembra daqui a N minutos: !lembrar 10 tirar o bolo',
        run: async (c) => {
          const [minutos, ...resto] = c.args;
          const n = Number(minutos);
          if (!Number.isFinite(n) || n <= 0 || resto.length === 0) {
            return 'Use: !lembrar 10 tirar o bolo';
          }
          const dados: Lembrete = { chatId: c.message.chat.id, texto: resto.join(' ') };
          await ctx.scheduler.at(Date.now() + n * 60_000, 'lembrar', dados);
          return `Combinado, em ${n} min.`;
        },
      }),
    );
  },
});
```

| Método | O que faz |
| --- | --- |
| `at(quando, job, payload?)` | Agenda e devolve o id. `quando` é `Date` ou milissegundos |
| `every(regra, job, payload?)` | Agenda uma série recorrente e devolve o id dela ([Jobs recorrentes](#jobs-recorrentes)) |
| `on(job, handler)` | Registra o handler. Ele recebe `(payload, { signal, scheduledAt, seriesId? })` |
| `next(id)` | `Date` da próxima ocorrência, ou `undefined` se o job não existe ou já disparou |
| `cancel(id)` | `true` se o job existia e ainda não tinha disparado. Numa série, encerra as próximas |

- **Registre o `on` no `setup`.** O job pertence ao plugin, não ao comando que o agendou: depois de
  um restart, ele espera o `on` para disparar.
- **O payload é JSON.** `Date`, `Map`, `undefined` e instâncias de classe são recusados com
  `TypeError`. Guarde a data como número (`date.getTime()`).
- **Os nomes são do plugin.** Dois plugins podem ter um job `lembrar` sem colidir.
- **Data no passado é válida:** o job dispara logo.

Para cancelar depois, guarde o id que o `at` devolveu, por exemplo no
[storage](storage.md), e chame `ctx.scheduler.cancel(id)`.

## Pelo menos uma vez

O job só sai do storage depois que o handler termina. Se o processo cair no meio do handler, o job
roda de novo quando o bot subir. Escreva o handler para tolerar uma repetição rara: confira no
storage se o trabalho já foi feito antes de refazer.

O handler que lança ou estoura o prazo (30 s) **não** é repetido: a falha vira `plugin.error`, e o
job sai. Para tentar de novo, trate o erro e agende outra vez:

```ts
ctx.scheduler.on('relatorio', async (payload, { signal }) => {
  try {
    await gerarRelatorio({ signal });
  } catch (err) {
    ctx.log.warn('relatório falhou; tento em 10 min', { err });
    await ctx.scheduler.at(Date.now() + 10 * 60_000, 'relatorio', payload);
  }
});
```

Repasse o `signal` a `fetch` e SDKs: ele aborta no prazo do job ou quando o plugin desce.

## Jobs recorrentes

`every` agenda uma série. O id que ele devolve não muda entre as ocorrências. Há dois tipos de
regra:

```ts
// Remédio todo dia às 08:00 em São Paulo.
await ctx.scheduler.every({ time: '08:00', timeZone: 'America/Sao_Paulo' }, 'remedio', { chatId });

// Reunião toda segunda às 19:00 (days: 0 = domingo ... 6 = sábado).
await ctx.scheduler.every(
  { time: '19:00', days: [1], timeZone: 'America/Sao_Paulo' },
  'reuniao',
  { chatId },
);

// Água a cada 1h30. O mínimo é 60 s; o intervalo conta do primeiro disparo.
const id = await ctx.scheduler.every({ everyMs: 90 * 60_000 }, 'agua', { chatId });
```

- **Regra inválida** (intervalo menor que 60 s, `time` fora de `HH:mm`, fuso desconhecido) rejeita
  com `TypeError`. Não há cron: as duas regras cobrem o uso comum.
- **Guarde o id** (por exemplo no [storage](storage.md)) e chame `ctx.scheduler.cancel(id)` para
  encerrar a série, mesmo com o handler rodando: ela não renasce. Para mudar a regra, cancele e
  chame `every` de novo. `ctx.scheduler.next(id)` diz quando é a próxima ocorrência.
- **Agende a partir de um comando**, não no `setup`: o `setup` roda a cada boot e a cada reload e
  criaria uma série nova toda vez.
- **Sem deriva.** A próxima ocorrência sai da regra, não do fim do handler: um handler de 10 s num
  intervalo de 1 min não atrasa a série.

O handler recebe `scheduledAt` (o horário previsto desta ocorrência) e `seriesId`:

```ts
ctx.scheduler.on('remedio', async (payload, { scheduledAt, seriesId }) => {
  const { chatId } = payload as { chatId: string };
  // Chave estável da ocorrência: uma repetição depois de um crash cai na mesma chave.
  const chave = `${seriesId}:${scheduledAt.getTime()}`;
  if (await ctx.storage.kv.get(chave)) return;
  await ctx.send.send(chatId, `Hora do remédio (${scheduledAt.toISOString()})`);
  await ctx.storage.kv.set(chave, true);
});
```

`scheduledAt` existe em todo job, inclusive o de `at`. `seriesId` só na série.

### Disparo perdido

Com o bot desligado na hora, a ocorrência vencida dispara **uma vez** ao subir, com o `scheduledAt`
antigo, e a série segue a regra a partir de agora: três dias fora do ar não geram três lembretes.
Compare `scheduledAt` com `Date.now()` no handler se uma mensagem velha não faz mais sentido.

A entrega é pelo menos uma vez, como no `at`: a série só avança depois do handler. Handler que
lança ou estoura o prazo não para a série (a falha vira `plugin.error` e a próxima ocorrência
segue). Se o processo cair no meio do handler, a ocorrência roda de novo na subida.

### Horário de verão

As regras de `time` usam o fuso informado. Um horário que não existe no dia da mudança (02:30 no
pulo da primavera) dispara deslocado pelo tamanho do pulo; um horário que ocorre duas vezes (a volta
do outono) dispara só na primeira. `America/Sao_Paulo` não tem horário de verão desde 2019.

## Tenant

O job agendado numa mensagem de um tenant guarda o tenant e roda nele: o `ctx.storage` do handler
lê os dados daquele cliente. O job agendado no `setup` roda sem tenant
([Storage → Tenants](storage.md#tenants-um-bot-vários-clientes)).

## Testar

O `receive()` do kit não espera os jobs. Teste o agendamento pela resposta:

```ts
const bot = await createTestBot({ plugins: [lembrete] });
await bot.receive({ text: '!lembrar 10 tirar o bolo' });
expect(bot.sent).toHaveReplied('Combinado, em 10 min.');
```

Um job com data no passado dispara logo; para conferir o efeito dele, espere com `expect.poll`:
`await expect.poll(() => bot.sent.length).toBe(2)`. Um handler longo fica mais fácil de testar
como função à parte, chamada pelo `on` e pelo teste. Mais em [Testes](testes.md).

Para uma série, ligue os fake timers do Vitest antes do `createTestBot` e avance o relógio; o
`scheduledAt` de cada ocorrência é exato:

```ts
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('dispara a cada minuto', async () => {
  const t0 = Date.now();
  const bot = await createTestBot({ plugins: [lembrete] });
  await bot.receive({ text: '!lembrar ligar' }); // chama ctx.scheduler.every({ everyMs: 60_000 }, ...)
  await vi.advanceTimersByTimeAsync(3 * 60_000);
  expect(vistos.map((v) => v.scheduledAt)).toEqual([t0 + 60_000, t0 + 120_000, t0 + 180_000]);
  await bot.stop();
});
```

Para testar uma regra de calendário, fixe o relógio com `vi.setSystemTime(Date.UTC(...))` antes.
