# Conversas: resposta esperada

O plugin faz uma pergunta e trata a resposta sem segurar o chat
([ADR 0060](../../../docs/adr/0060-resposta-esperada.md)). Exemplo: "!notas" → "De qual aluno?" →
"Maria" → notas da Maria.

## Por que não `await` a próxima mensagem

A fila de entrada processa uma mensagem por chat por vez, e a tarefa da mensagem só termina quando
o comando termina ([ADR 0042](../../../docs/adr/0042-handler-lento-segura-o-chat.md)). Um `run`
que espera a próxima mensagem do mesmo chat espera uma tarefa que está na fila atrás dele. Ele
fica preso até o `commandMs` estourar.

Com a resposta esperada, o handler envia a pergunta, registra qual passo trata a resposta e
**termina**. O chat fica livre, e a mensagem seguinte daquela pessoa vai para o passo.

## Uso

```ts
setup(ctx) {
  ctx.commands.add(
    command({
      name: 'notas',
      run: async (c) => {
        await c.reply('De qual aluno?');
        c.expectReply('aluno', { data: { ano: c.args[0] ?? '2026' } });
      },
    }),
  );

  ctx.conversations.define('aluno', async (c) => {
    const { ano } = c.data as { ano: string };
    if (c.text === 'cancelar') return c.reply('Ok, cancelado.');
    await c.reply(await buscarNotas(c.text, ano, { signal: c.signal }));
  });
}
```

- **`ctx.conversations.define(step, handler)`**, no `setup`, define um passo do plugin. Um nome
  vazio ou repetido no mesmo plugin lança `TypeError`, e o setup falha.
- **`expectReply(step, { data, ttlMs })`** registra que a próxima mensagem do **remetente**,
  **neste chat**, vai para `step`. Existe no contexto do comando (`run` e `onReject`), dos
  listeners de mensagem (`message`, `message:<tipo>`, `message.edited`) e do próprio passo. É
  síncrono.
  - `data`: estado do fluxo (`JsonValue`), entregue em `c.data`. Padrão: `null`.
  - `ttlMs`: validade da espera. Padrão: 5 minutos.
  - Passo que o plugin não definiu lança `TypeError`. `ttlMs` que não é finito e > 0, ou que
    passa de 2³¹−1 ms (~24,8 dias), lança `RangeError`.
  - O plugin só aponta para os próprios passos.
- **O passo** recebe o contexto da mensagem que respondeu (`message`, `text`, `reply`, `react`,
  `log`, `t`), mais `step`, `data`, `signal` e `expectReply`.

Para encadear perguntas, o passo chama `expectReply` de novo:

```ts
ctx.conversations.define('aluno', async (c) => {
  await c.reply('Qual bimestre?');
  c.expectReply('bimestre', { data: { aluno: c.text } });
});
ctx.conversations.define('bimestre', async (c) => {
  const { aluno } = c.data as { aluno: string };
  await c.reply(await notasDoBimestre(aluno, c.text));
});
```

## Regras

- **Uma espera por (chat, remetente).** Registrar de novo, pelo mesmo plugin ou por outro,
  substitui a anterior. Quem abriu o fluxo mais recente recebe a resposta.
- **Só o remetente.** Em grupo, a mensagem de outra pessoa segue o fluxo normal (comando ou
  listeners). O mesmo remetente em outro chat também.
- **A espera vem antes do roteador.** A mensagem que responde vai só ao passo: não passa pelo
  roteador e não chega aos listeners de `message` nem ao evento `command`. Os middlewares rodam
  antes, como para qualquer mensagem (`ignoreSelf`, `chatFilter`, `rateLimit`...).
- **Um comando digitado cancela a espera.** Se o texto casa com um comando registrado, a espera é
  descartada e o comando roda. Não existe palavra reservada no kernel para "cancelar": se quiser
  uma, trate-a no passo, porque para o kernel ela é texto comum. Com o prefixo vazio
  ([Comandos](commands.md#prefixo-por-chat)), responder `ajuda` a um passo roda o comando `ajuda`.
- **A espera vale uma vez.** A resposta a consome. Depois dela, a mensagem seguinte segue o fluxo
  normal, a menos que o passo registre outra espera.
- **Expiração.** Passado o `ttlMs`, a espera some, e a próxima mensagem segue o fluxo normal. Sem
  `onExpire` no passo, some sem aviso; com ele, o plugin reage
  ([Quando a espera vence](#quando-a-espera-vence-onexpire)).
- **Edição não responde.** Só mensagem nova (`message`) consome a espera.
- **O menu numerado também é uma espera.** Sem botões, as [ações](actions.md) de um `reply`
  registram uma espera do kernel para o remetente. Um `expectReply` depois do `reply` com ações a
  substitui, e o número deixa de valer. O clique num botão cancela a espera de quem clicou.

## Quando a espera vence: `onExpire`

Para avisar quem parou de responder, lembrar de terminar um cadastro ou registrar o abandono de um
funil, passe `onExpire` no `define`
([ADR 0097](../../../docs/adr/0097-onexpire-do-passo.md)):

```ts
ctx.conversations.define('nome', (c) => c.reply(`Olá, ${c.text}`), {
  onExpire: async (c) => {
    await c.reply('Encerrei por falta de resposta. Mande !cadastro para recomeçar.');
  },
});
```

- **Só quando o TTL vence.** Não roda quando a espera é respondida, substituída por outro
  `expectReply` (do mesmo plugin ou de outro), descartada porque o texto casou um comando ou pelo
  clique num botão, nem quando o plugin desce (teardown, reload) ou o bot para (`stop()`).
- **O contexto** traz `chat`, `sender` (quem não respondeu), `step`, `data`, `reply`, `log`, `t`,
  `signal` e `expectReply`. Não há `message`, `text` nem `react`: nenhuma mensagem chegou. O
  `reply` envia no chat da espera, sem citar. As ações de passo num `reply` apontam para os passos
  do plugin, como no passo.
- **Encadeia outra espera.** `c.expectReply` abre uma nova para a mesma pessoa no mesmo chat:

  ```ts
  ctx.conversations.define('nome', tratarNome, {
    onExpire: async (c) => {
      await c.reply('Ainda está aí?');
      c.expectReply('nome', { data: c.data, ttlMs: 60_000 });
    },
  });
  ```

- **Roda na fila do chat**, como uma mensagem: não corre junto com outra mensagem do mesmo chat.
  Quem entra primeiro na fila decide. Se a resposta da pessoa já estava na fila quando o TTL
  venceu, ela vai ao passo e o `onExpire` não roda. Se a expiração entrou primeiro, o `onExpire`
  roda e a resposta segue o fluxo normal.
- **Não passa pelos middlewares**, porque não há mensagem. A espera só existe porque uma mensagem
  do chat já passou por eles.
- **Prazo e erros como no passo**: o prazo do comando (`timeouts.commandMs`). Estourado, o
  `c.signal` aborta com `StepTimeoutError` (`stage: 'onExpire'`), e o `reply` e o `expectReply`
  passam a ser recusados com `ContextExpiredError`. A falha, ou o prazo estourado, vira
  `plugin.error` com `phase: 'step-expire'` e `event` igual ao nome do passo.
- **Fila do chat cheia**: a expiração é descartada com uma linha `warn`, e o `onExpire` não roda.
- **`settled()`**: o `onExpire` rodando (ou na fila) conta; o TTL pendente não.
- `onExpire` que não é função lança `TypeError` no `define`, e o setup falha.

## Prazo e erros

O passo roda dentro da tarefa da fila do chat e tem o prazo do comando (`timeouts.commandMs`).
Estourado o prazo, o `c.signal` aborta com `StepTimeoutError` (`plugin`, `step`, `timeoutMs`), o
chat é liberado e sai `plugin.error` com `timedOut: true`. Um passo que lança vira `plugin.error`
com `phase: 'step'` e `event` igual ao nome do passo.

Como o `reply`, o `expectReply` de um contexto que expirou (prazo estourado ou plugin descartado)
lança `ContextExpiredError`. Um handler atrasado não abre uma conversa que ninguém pediu.

## Ciclo de vida

- O estado fica **em memória**. Um restart perde as conversas em andamento, e o usuário recomeça.
  O passo é nomeado e o `data` é JSON para que, no futuro, a espera possa ir ao storage sem mudar
  a API.
- No `teardown`/reload, o plugin perde os passos e as esperas dele, sem `onExpire`. A resposta
  que chegar depois segue o fluxo normal. Um `onExpire` rodando no reload tem o `signal` abortado
  e o `reply` recusado.
- No `stop()`, as esperas que restam são descartadas sem `onExpire`, e nenhum timer de validade
  sobrevive. Uma espera que vence durante o `stop()` também some em silêncio.
- O `settled()` não espera o `ttlMs`: a espera não é trabalho em andamento. O passo e o
  `onExpire`, quando rodam, já contam, porque rodam dentro da fila do chat.
- Não depende de capability: funciona em qualquer transport.

## Testando

Com o kit (`@usebridger/testing`), a conversa é uma sequência de mensagens:

```ts
const bot = await createTestBot({ plugins: [notas] });
await bot.receive({ text: '!notas' });
await bot.receive({ text: 'Maria' });
expect(bot.sent).toContainText('Notas de Maria');
```

Para o `onExpire`, vença a espera com os fake timers do Vitest e espere o bot assentar
([kit de testes](../../testing/docs/README.md#espera-que-vence-onexpire)):

```ts
vi.useFakeTimers();
const bot = await createTestBot({ plugins: [cadastro] });
await bot.receive({ text: '!cadastro' });
await vi.advanceTimersByTimeAsync(60_000);
await bot.bot.settled();
expect(bot.sent).toContainText('Encerrei por falta de resposta.');
```
