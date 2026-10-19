# ADR 0100 — Jobs recorrentes: `scheduler.every`

**Status:** Aceito (2026-10-16) · Detalha **D11** ([ADR 0011](0011-escopo-do-core.md)) · Segue
**D29** ([ADR 0029](0029-cancelamento-cooperativo.md)) e **D68**
([ADR 0068](0068-isolamento-por-tenant.md))

## Contexto

O scheduler só tinha `at` (#135). Quem queria "remédio todo dia às 8h" fazia o handler agendar a
próxima execução com `at(Date.now() + UM_DIA)`. Isso deriva (o prazo conta do fim do handler),
perde a série se o handler falha antes de reagendar, não respeita fuso nem horário de verão e
deixa o `cancel` sem nada a cancelar quando o handler roda.

Alternativas consideradas:

- **Expressão cron.** Mais superfície de parse e de validação, e os casos da issue (intervalo,
  horário fixo por dia da semana) cabem numa regra simples.
- **Série como vários documentos `at` pré-gerados.** Cresce sem limite e o `cancel` teria de achar
  todos.
- **Coleção separada para séries.** Um segundo loop ou um segundo caminho de disparo, e a suíte de
  contrato do storage mudaria.
- **Biblioteca de datas/Temporal.** Dependência para uma conta que o `Intl` resolve.

## Decisão

- **API:** `every(rule, job, payload?)` devolve o id da série. A regra é `{ everyMs }` (mínimo
  60 s) ou de calendário `{ time: 'HH:mm', days?, timeZone }` (`days` 0 = domingo a 6 = sábado;
  ausente, todo dia). Regra, nome ou payload inválidos rejeitam com `TypeError`.
- **Série é um documento** na mesma coleção `jobs`, com o campo opcional `rule`. O id é estável;
  `fireAt` é a ocorrência pendente. O formato persistido só ganha um campo opcional: sem migração
  e sem mudar a suíte de contrato.
- **Sem deriva.** A próxima ocorrência sai da regra, a partir da ocorrência prevista, não do fim
  do handler. O intervalo é ancorado no primeiro disparo.
- **Horário de verão, só com `Intl`.** Horário que não existe (pulo da primavera) desloca pelo
  tamanho do pulo (semântica "compatible" do Temporal). Horário ambíguo (volta do outono) dispara
  só na primeira vez.
- **Pelo menos uma vez, como no `at`.** A série só avança depois do handler. Handler que lança ou
  estoura o prazo também avança (a série não para por uma falha). Handler abandonado no `stop` não
  avança: a ocorrência fica pendente para a próxima subida.
- **Disparo perdido.** Depois de downtime, a ocorrência vencida dispara uma vez ao subir, com o
  `scheduledAt` antigo, e a série segue a regra a partir de agora (sem rajada de recuperação).
  Sem opção por série: ninguém pediu, e o plugin tem o `scheduledAt` para decidir se ainda vale.
- **`cancel(seriesId)` apaga o documento mesmo com o handler rodando.** O avanço depois do handler
  é um `update` por id que casa 0 documentos, então a série não renasce. O `at` em andamento segue
  devolvendo `false`.
- **Contexto do job:** `JobContext.scheduledAt` (todo job) e `seriesId` (só série) servem a
  mensagem ("tomou o das 08:00?") e a idempotência. `next(id)` devolve a próxima ocorrência
  pendente (`undefined` se não existe, é de outro plugin ou o `at` já disparou).

## Consequências

- A issue #135 sai sem cron, sem dependência e sem migração.
- Ocorrências perdidas por downtime são puladas, não repostas.
- Mudar a regra de uma série é `cancel` + `every`.
- Regra que não dá mais para calcular na hora de avançar (fuso removido do ICU, formato desconhecido) vai ao `onError` e a série é apagada, para não virar loop de reentrega.
- O tenant de origem vale em todas as ocorrências (ADR 0068).
